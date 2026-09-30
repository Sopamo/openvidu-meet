import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { AssetsService } from '../../../../../shared/services/assets.service';
import { ILogger } from '../../models/logger.model';
import {
	SPATIAL_AUDIO_GEOMETRY,
	SPATIAL_AUDIO_SPREAD,
	SpatialAngle,
	SpatialAudioMode,
	SpatialPlacement
} from '../../models/spatial-audio.model';
import { StorageKeys } from '../../models/storage.model';
import { RemoteAudioTrack } from '../livekit-adapter';
import { LoggerService } from '../logger/logger.service';
import { StorageService } from '../storage/storage.service';
import { HeadTrackingService } from './head-tracking.service';

/** TH Köln KU100 HRIRs, 1.5 m, horizontal plane: [azimuth 0..359 (counter-clockwise)][left, right][128 taps]. */
const HRIR_FILE = 'assets/hrtf/thk-ku100-nf150-circ360.f32';
const HRIR_RATE = 48000;
const HRIR_TAPS = 128;
/** Crossfade between two HRIRs when a voice's direction changes (seconds). */
const HRIR_FADE = 0.03;
/** Distance of the voices for the PannerNode (metres): the TH Köln set is measured at 1.5 m too. */
const DISTANCE = 1.5;

/** The TH Köln rendering of one voice: two convolvers, crossfaded when the direction changes. */
interface HrirVoice {
	/** Our volume, feeding the convolvers. */
	send: GainNode;
	/** Silences LiveKit's own direct path to the speakers. */
	mute: GainNode;
	convolvers: [ConvolverNode, ConvolverNode];
	fades: [GainNode, GainNode];
	active: 0 | 1;
	/** HRIR index (azimuth in degrees, counter-clockwise) the active convolver plays, and the one wanted. */
	index: number;
	target: number;
	busyUntil: number;
	timer?: ReturnType<typeof setTimeout>;
}

/** One remote audio track (a microphone or a screen share's audio) routed through spatial audio. */
interface SpatialTrack {
	key: string;
	track: RemoteAudioTrack;
	volume: number;
	/** The mode the track's Web Audio chain is currently built for. */
	wiredMode: SpatialAudioMode;
	panner?: PannerNode;
	hrir?: HrirVoice;
}

/**
 * @internal
 *
 * Spatial audio for remote participants: each voice comes from where that person's tile is on the screen, as
 * seen from the user's head, as if the others sat behind the screen in the user's own office.
 *
 * The user is assumed to sit {@link SPATIAL_AUDIO_GEOMETRY} (60 cm) in front of the middle of a 30" screen, so
 * the directions are real: a tile at the screen's edge is about 29° to the side, neighbours a few degrees apart.
 * A "spread" factor (a local setting) widens them. All voices are on the horizontal plane. With head tracking
 * (a local setting, {@link HeadTrackingService}) the directions follow the user's head, so the voices stay put in
 * the room when the head turns.
 *
 * A local choice of each user, remembered in `localStorage`:
 * - {@link SpatialAudioMode.PANNER}: a Web Audio `PannerNode` per track with the browser's built-in HRTF.
 * - {@link SpatialAudioMode.THK}: measured HRIRs of TH Köln (Neumann KU100, 1.5 m, every 1° around the head),
 *   convolved per voice, crossfaded between neighbouring directions.
 *
 * Remote audio already plays through Web Audio (`webAudioMix`, for per-participant volumes); the nodes are
 * inserted into each track's chain with LiveKit's `setWebAudioPlugins`. They must live in LiveKit's
 * AudioContext, so the room is given {@link audioContext} (48 kHz, the rate of the HRIRs and of WebRTC audio).
 */
@Injectable({
	providedIn: 'root'
})
export class SpatialAudioService {
	private readonly storage = inject(StorageService);
	private readonly assets = inject(AssetsService);
	private readonly headTracking = inject(HeadTrackingService);
	private readonly log: ILogger = inject(LoggerService).get('SpatialAudioService');

	private readonly _mode = signal<SpatialAudioMode>(this.readStoredMode());
	readonly mode = this._mode.asReadonly();
	readonly enabled = computed(() => this._mode() !== SpatialAudioMode.OFF);

	private readonly _spread = signal<number>(this.readStoredSpread());
	/** Factor on the directions: 1 = physically accurate, more = more pronounced. */
	readonly spread = this._spread.asReadonly();

	private readonly _headTrackingEnabled = signal<boolean>(this.storage.getHeadTracking());
	readonly headTrackingEnabled = this._headTrackingEnabled.asReadonly();

	private readonly _debug = signal<boolean>(this.storage.getSpatialAudioDebug());
	/** Whether the video tiles show the angle each voice is played from. */
	readonly debug = this._debug.asReadonly();
	private readonly _debugAngles = signal<Record<string, SpatialAngle>>({});
	/** The current angle of each voice, keyed by {@link key} (updated at most 10 times a second, debug only). */
	readonly debugAngles = this._debugAngles.asReadonly();
	private readonly angles = new Map<string, SpatialAngle>();
	private anglesTimer?: ReturnType<typeof setTimeout>;

	private context: AudioContext | undefined;
	/** Output of all TH Köln voices. */
	private hrirBus: GainNode | undefined;
	private hrirData: Float32Array<ArrayBuffer> | undefined;
	private hrirLoading = false;
	private readonly hrirReady = signal(false);
	private readonly hrirBuffers = new Map<number, AudioBuffer>();

	private readonly tracks = new Map<string, SpatialTrack>();
	/** Whether a meeting layout is on screen (head tracking only runs in a meeting). */
	private readonly inMeeting = signal(false);
	private placements = new Map<string, SpatialPlacement>();
	/** The user's head yaw in radians (positive: turned right), 0 without head tracking. */
	private headYaw = 0;

	/** Rebuilds every track's chain when the user switches modes (or the HRIRs finish loading). */
	private readonly rewireEffect = effect(() => {
		this._mode();
		this.hrirReady();
		untracked(() => this.tracks.forEach((entry) => this.wire(entry)));
	});

	/** Re-positions the voices when the spread changes. */
	private readonly spreadEffect = effect(() => {
		this._spread();
		untracked(() => this.tracks.forEach((entry) => this.applyPosition(entry)));
	});

	/** Head tracking runs while it is enabled, spatial audio is on and the user is in a meeting. */
	private readonly headTrackingEffect = effect(() => {
		const run = this.enabled() && this._headTrackingEnabled() && this.inMeeting();
		untracked(() => (run ? this.headTracking.start() : this.headTracking.stop()));
	});

	constructor() {
		this.headTracking.onYaw = (yaw) => {
			this.headYaw = yaw;
			this.tracks.forEach((entry) => this.applyPosition(entry));
		};
		// Keep tabs of the same browser in step.
		window.addEventListener('storage', (event) => {
			if (event.key?.endsWith(StorageKeys.SPATIAL_AUDIO)) this._mode.set(this.readStoredMode());
			if (event.key?.endsWith(StorageKeys.SPATIAL_AUDIO_SPREAD)) this._spread.set(this.readStoredSpread());
			if (event.key?.endsWith(StorageKeys.HEAD_TRACKING)) this._headTrackingEnabled.set(this.storage.getHeadTracking());
			if (event.key?.endsWith(StorageKeys.SPATIAL_AUDIO_DEBUG)) this._debug.set(this.storage.getSpatialAudioDebug());
		});
	}

	/** Key of a remote audio stream: its participant and whether it belongs to a screen share. */
	static key(identity: string, isScreen: boolean): string {
		return `${identity}:${isScreen ? 'screen' : 'camera'}`;
	}

	setMode(mode: SpatialAudioMode): void {
		if (!Object.values(SpatialAudioMode).includes(mode)) return;
		this._mode.set(mode);
		this.storage.setSpatialAudioMode(mode);
	}

	setSpread(spread: number): void {
		const clamped = Math.min(SPATIAL_AUDIO_SPREAD.max, Math.max(SPATIAL_AUDIO_SPREAD.min, spread));
		this._spread.set(clamped);
		this.storage.setSpatialAudioSpread(clamped);
	}

	/** Called by the meeting layout when it appears and disappears. */
	setInMeeting(inMeeting: boolean): void {
		this.inMeeting.set(inMeeting);
	}

	setHeadTracking(enabled: boolean): void {
		this._headTrackingEnabled.set(enabled);
		this.storage.setHeadTracking(enabled);
	}

	setDebug(enabled: boolean): void {
		this._debug.set(enabled);
		this.storage.setSpatialAudioDebug(enabled);
		if (enabled) this.tracks.forEach((entry) => this.applyPosition(entry));
	}

	/** The AudioContext remote audio is mixed in (handed to LiveKit as `webAudioMix.audioContext`). */
	get audioContext(): AudioContext {
		if (!this.context || this.context.state === 'closed') {
			this.context = new AudioContext({ latencyHint: 'interactive', sampleRate: HRIR_RATE });
			// Nodes and buffers of an old context can't be used with a new one.
			this.hrirBus = undefined;
			this.hrirBuffers.clear();
		}
		return this.context;
	}

	/**
	 * Plays a remote audio track at the given playback volume (0-4), spatialised if enabled. Called on every
	 * layout audio pass, so it only rebuilds the chain when the track or the mode changed.
	 */
	play(key: string, track: RemoteAudioTrack, volume: number): void {
		let entry = this.tracks.get(key);
		if (entry && entry.track !== track) {
			this.unwire(entry);
			entry = undefined;
		}
		if (!entry) {
			// LiveKit starts with no plugins, i.e. the chain of SpatialAudioMode.OFF.
			entry = { key, track, volume, wiredMode: SpatialAudioMode.OFF };
			this.tracks.set(key, entry);
			this.wire(entry);
		}
		entry.volume = volume;
		this.applyVolume(entry);
		this.applyPosition(entry);
	}

	/** Forgets a track that is no longer played. */
	release(key: string): void {
		const entry = this.tracks.get(key);
		if (!entry) return;
		this.unwire(entry);
		this.tracks.delete(key);
		this.angles.delete(key);
	}

	/**
	 * Where the remote streams' tiles are on the screen, keyed by {@link key}. Streams without a tile (hidden by
	 * the smart layout) come from straight ahead.
	 */
	setPlacements(placements: Map<string, SpatialPlacement>): void {
		this.placements = placements;
		this.tracks.forEach((entry) => this.applyPosition(entry));
	}

	/** The mode a chain can be built for right now: the TH Köln mode plays unspatialised until its HRIRs load. */
	private effectiveMode(): SpatialAudioMode {
		const mode = this._mode();
		if (mode !== SpatialAudioMode.THK || this.hrirData) return mode;
		this.loadHrirs();
		return SpatialAudioMode.OFF;
	}

	private wire(entry: SpatialTrack): void {
		const mode = this.effectiveMode();
		if (entry.wiredMode === mode) return;
		this.unwire(entry);

		const ctx = this.audioContext;
		if (mode === SpatialAudioMode.PANNER) {
			entry.panner = new PannerNode(ctx, {
				panningModel: 'HRTF',
				distanceModel: 'inverse',
				refDistance: 1,
				rolloffFactor: 0
			});
			entry.track.setWebAudioPlugins([entry.panner]);
		} else if (mode === SpatialAudioMode.THK) {
			entry.hrir = this.createHrirVoice(ctx);
			entry.track.setWebAudioPlugins([entry.hrir.send, entry.hrir.mute]);
		} else {
			entry.track.setWebAudioPlugins([]);
		}
		entry.wiredMode = mode;
		this.applyVolume(entry);
		this.applyPosition(entry);
	}

	private unwire(entry: SpatialTrack): void {
		entry.panner?.disconnect();
		const hrir = entry.hrir;
		if (hrir) {
			clearTimeout(hrir.timer);
			[hrir.send, hrir.mute, ...hrir.convolvers, ...hrir.fades].forEach((node) => node.disconnect());
		}
		entry.panner = entry.hrir = undefined;
		entry.wiredMode = SpatialAudioMode.OFF;
	}

	private createHrirVoice(ctx: AudioContext): HrirVoice {
		if (!this.hrirBus) {
			this.hrirBus = ctx.createGain();
			this.hrirBus.connect(ctx.destination);
		}
		const send = ctx.createGain();
		// LiveKit connects the last plugin to its own gain and the speakers; this path stays silent, the
		// convolvers play the voice instead.
		const mute = ctx.createGain();
		mute.gain.value = 0;
		const convolvers: [ConvolverNode, ConvolverNode] = [
			new ConvolverNode(ctx, { disableNormalization: true }),
			new ConvolverNode(ctx, { disableNormalization: true })
		];
		const fades: [GainNode, GainNode] = [ctx.createGain(), ctx.createGain()];
		fades[1].gain.value = 0;
		for (const i of [0, 1]) {
			send.connect(convolvers[i]);
			convolvers[i].connect(fades[i]);
			fades[i].connect(this.hrirBus);
		}
		convolvers[0].buffer = this.hrirBuffer(0);
		return { send, mute, convolvers, fades, active: 0, index: 0, target: 0, busyUntil: 0 };
	}

	private applyVolume(entry: SpatialTrack): void {
		if (entry.hrir) {
			entry.hrir.send.gain.setTargetAtTime(entry.volume, this.audioContext.currentTime, 0.05);
		} else {
			entry.track.setVolume(entry.volume);
		}
	}

	private applyPosition(entry: SpatialTrack): void {
		if (!entry.panner && !entry.hrir) return;
		// Direction of the voice relative to where the head points (positive: to the right).
		const tile = this.azimuthOf(this.placements.get(entry.key));
		const azimuth = tile - this.headYaw;
		if (this._debug()) this.showAngle(entry, tile, azimuth);
		if (entry.panner) {
			const t = this.audioContext.currentTime;
			entry.panner.positionX.setTargetAtTime(Math.sin(azimuth) * DISTANCE, t, 0.03);
			entry.panner.positionY.setTargetAtTime(0, t, 0.03);
			entry.panner.positionZ.setTargetAtTime(-Math.cos(azimuth) * DISTANCE, t, 0.03);
		}
		if (entry.hrir) {
			// The HRIR set counts azimuth counter-clockwise (90 = left).
			const degrees = Math.round((-azimuth * 180) / Math.PI);
			entry.hrir.target = ((degrees % 360) + 360) % 360;
			this.switchHrir(entry.hrir);
		}
	}

	/** Debug: remembers the angles of a voice and publishes all of them at most 10 times a second. */
	private showAngle(entry: SpatialTrack, tile: number, azimuth: number): void {
		const deg = (rad: number) => Math.round((rad * 1800) / Math.PI) / 10;
		// The TH Köln voices play the nearest measured direction (whole degrees).
		const played = entry.hrir ? Math.round((azimuth * 180) / Math.PI) : deg(azimuth);
		this.angles.set(entry.key, { azimuth: played, tile: deg(tile), head: deg(this.headYaw) });
		this.anglesTimer ??= setTimeout(() => {
			this.anglesTimer = undefined;
			this._debugAngles.set(Object.fromEntries(this.angles));
		}, 100);
	}

	/**
	 * Azimuth (radians, positive: right) of a tile as seen from the user's head, 60 cm in front of the middle of a
	 * 30" screen, times the spread. Without a tile: straight ahead.
	 */
	private azimuthOf(placement: SpatialPlacement | undefined): number {
		if (!placement) return 0;
		const screenWidthPx = window.screen?.width || window.innerWidth;
		const offsetCm = (placement.screenX - screenWidthPx / 2) * (SPATIAL_AUDIO_GEOMETRY.screenWidthCm / screenWidthPx);
		const azimuth = Math.atan2(offsetCm, SPATIAL_AUDIO_GEOMETRY.viewingDistanceCm) * this._spread();
		return Math.max(-Math.PI / 2, Math.min(Math.PI / 2, azimuth));
	}

	/** Crossfades a voice to its target HRIR, one switch at a time (queued while a crossfade is running). */
	private switchHrir(voice: HrirVoice): void {
		if (voice.target === voice.index || voice.timer) return;
		const ctx = this.audioContext;
		const now = ctx.currentTime;
		if (now < voice.busyUntil) {
			voice.timer = setTimeout(() => {
				voice.timer = undefined;
				this.switchHrir(voice);
			}, (voice.busyUntil - now) * 1000 + 5);
			return;
		}
		const next = voice.active === 0 ? 1 : 0;
		voice.convolvers[next].buffer = this.hrirBuffer(voice.target);
		const fadeOut = voice.fades[voice.active].gain;
		const fadeIn = voice.fades[next].gain;
		fadeOut.cancelScheduledValues(now);
		fadeOut.setValueAtTime(fadeOut.value, now);
		fadeOut.linearRampToValueAtTime(0, now + HRIR_FADE);
		fadeIn.cancelScheduledValues(now);
		fadeIn.setValueAtTime(0, now);
		fadeIn.linearRampToValueAtTime(1, now + HRIR_FADE);
		voice.active = next;
		voice.index = voice.target;
		voice.busyUntil = now + HRIR_FADE + 0.005;
	}

	/** Stereo impulse response for an azimuth (degrees, counter-clockwise), created on first use. */
	private hrirBuffer(index: number): AudioBuffer {
		let buffer = this.hrirBuffers.get(index);
		if (!buffer) {
			buffer = this.audioContext.createBuffer(2, HRIR_TAPS, HRIR_RATE);
			const offset = index * 2 * HRIR_TAPS;
			buffer.copyToChannel(this.hrirData!.subarray(offset, offset + HRIR_TAPS), 0);
			buffer.copyToChannel(this.hrirData!.subarray(offset + HRIR_TAPS, offset + 2 * HRIR_TAPS), 1);
			this.hrirBuffers.set(index, buffer);
		}
		return buffer;
	}

	/** Loads the TH Köln HRIRs on first use (360 KB). */
	private loadHrirs(): void {
		if (this.hrirLoading) return;
		this.hrirLoading = true;
		if (this.audioContext.sampleRate !== HRIR_RATE) {
			this.log.e(`AudioContext runs at ${this.audioContext.sampleRate} Hz, the HRIRs need ${HRIR_RATE} Hz`);
			this.setMode(SpatialAudioMode.PANNER);
			return;
		}
		fetch(this.assets.resolve(HRIR_FILE))
			.then((response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.arrayBuffer();
			})
			.then((data) => {
				if (data.byteLength !== 360 * 2 * HRIR_TAPS * 4) throw new Error(`unexpected size ${data.byteLength}`);
				this.hrirData = new Float32Array(data);
				this.hrirReady.set(true);
			})
			.catch((error: unknown) => {
				this.log.e('Could not load the TH Köln HRIRs, falling back to the PannerNode', error);
				this.hrirLoading = false;
				this.setMode(SpatialAudioMode.PANNER);
			});
	}

	private readStoredMode(): SpatialAudioMode {
		const stored = this.storage.getSpatialAudioMode();
		// The Resonance Audio mode of an earlier version became the TH Köln mode.
		if (stored === 'resonance') return SpatialAudioMode.THK;
		return stored && (Object.values(SpatialAudioMode) as string[]).includes(stored)
			? (stored as SpatialAudioMode)
			: SpatialAudioMode.OFF;
	}

	private readStoredSpread(): number {
		const stored = this.storage.getSpatialAudioSpread();
		return typeof stored === 'number' && stored >= SPATIAL_AUDIO_SPREAD.min && stored <= SPATIAL_AUDIO_SPREAD.max
			? stored
			: SPATIAL_AUDIO_SPREAD.default;
	}
}
