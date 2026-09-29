import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { ILogger } from '../../models/logger.model';
import { SpatialAudioMode, SpatialPlacement } from '../../models/spatial-audio.model';
import { StorageKeys } from '../../models/storage.model';
import { RemoteAudioTrack } from '../livekit-adapter';
import { LoggerService } from '../logger/logger.service';
import { StorageService } from '../storage/storage.service';

/** The parts of Resonance Audio (which ships no type declarations) used here. */
interface ResonanceScene {
	output: AudioNode;
	createSource(options?: Record<string, unknown>): ResonanceSource;
}
interface ResonanceSource {
	input: AudioNode;
	setPosition(x: number, y: number, z: number): void;
}

/** One remote audio track (a microphone or a screen share's audio) routed through spatial audio. */
interface SpatialTrack {
	key: string;
	track: RemoteAudioTrack;
	volume: number;
	/** The mode the track's Web Audio chain is currently built for. */
	wiredMode: SpatialAudioMode;
	panner?: PannerNode;
	/** Resonance: our volume, feeding the scene source. */
	sendGain?: GainNode;
	/** Resonance: silences LiveKit's own direct path to the speakers. */
	muteGain?: GainNode;
	resonanceSource?: ResonanceSource;
}

/**
 * @internal
 *
 * Spatial audio for remote participants: each voice comes from where that person's tile sits in the layout
 * (see `calculateSpatialLayout`, which also arranges the tiles around the local user while this is enabled).
 *
 * A local choice of each user, remembered in `localStorage`:
 * - {@link SpatialAudioMode.PANNER}: a Web Audio `PannerNode` per track with the browser's built-in HRTF.
 * - {@link SpatialAudioMode.RESONANCE}: Resonance Audio (loaded on first use) renders all tracks through one
 *   ambisonic scene with a small, damped virtual room.
 *
 * Remote audio already plays through Web Audio (`webAudioMix`, for per-participant volumes); the spatial nodes
 * are inserted into each track's chain with LiveKit's `setWebAudioPlugins`. They must live in LiveKit's
 * AudioContext, so the room is given {@link audioContext} instead of creating its own.
 */
@Injectable({
	providedIn: 'root'
})
export class SpatialAudioService {
	/** Distance of every voice from the listener, in metres: only the direction changes. */
	private static readonly DISTANCE = 1.5;
	/** Voices this close to the centre of the layout (e.g. a centred screen share) come from straight ahead. */
	private static readonly CENTRE_RADIUS = 0.12;

	private readonly storage = inject(StorageService);
	private readonly log: ILogger = inject(LoggerService).get('SpatialAudioService');

	private readonly _mode = signal<SpatialAudioMode>(this.readStoredMode());
	readonly mode = this._mode.asReadonly();
	readonly enabled = computed(() => this._mode() !== SpatialAudioMode.OFF);

	private context: AudioContext | undefined;
	private scene: ResonanceScene | undefined;
	private sceneLoading = false;
	private readonly sceneReady = signal(false);
	private readonly freeResonanceSources: ResonanceSource[] = [];

	private readonly tracks = new Map<string, SpatialTrack>();
	private placements = new Map<string, SpatialPlacement>();

	/** Rebuilds every track's chain when the user switches modes (or Resonance finishes loading). */
	private readonly rewireEffect = effect(() => {
		this._mode();
		this.sceneReady();
		untracked(() => this.tracks.forEach((entry) => this.wire(entry)));
	});

	constructor() {
		// Keep tabs of the same browser in step.
		window.addEventListener('storage', (event) => {
			if (event.key?.endsWith(StorageKeys.SPATIAL_AUDIO)) {
				this._mode.set(this.readStoredMode());
			}
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

	/** The AudioContext remote audio is mixed in (handed to LiveKit as `webAudioMix.audioContext`). */
	get audioContext(): AudioContext {
		if (!this.context || this.context.state === 'closed') {
			this.context = new AudioContext({ latencyHint: 'interactive' });
			// A new context means a new scene: sources of the old one can't be connected to it.
			this.scene = undefined;
			this.sceneLoading = false;
			this.freeResonanceSources.length = 0;
			this.sceneReady.set(false);
		}
		return this.context;
	}

	/**
	 * Plays a remote audio track at the given playback volume (0-2), spatialised if enabled. Called on every
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
	}

	/**
	 * Positions of all streams in the current layout, keyed by {@link key}. Streams without a tile (hidden by
	 * the smart layout) come from straight ahead.
	 */
	setPlacements(placements: Map<string, SpatialPlacement>): void {
		this.placements = placements;
		this.tracks.forEach((entry) => this.applyPosition(entry));
	}

	/** The mode a chain can be built for right now: Resonance plays unspatialised until it has loaded. */
	private effectiveMode(): SpatialAudioMode {
		const mode = this._mode();
		if (mode !== SpatialAudioMode.RESONANCE) return mode;
		if (this.scene) return mode;
		this.loadResonance();
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
		} else if (mode === SpatialAudioMode.RESONANCE && this.scene) {
			entry.resonanceSource = this.freeResonanceSources.pop() ?? this.scene.createSource({ rolloff: 'none' });
			entry.sendGain = ctx.createGain();
			entry.sendGain.connect(entry.resonanceSource.input);
			// LiveKit connects the last plugin to its own gain and the speakers; this path stays silent, the
			// scene plays the voice instead.
			entry.muteGain = ctx.createGain();
			entry.muteGain.gain.value = 0;
			entry.track.setWebAudioPlugins([entry.sendGain, entry.muteGain]);
		} else {
			entry.track.setWebAudioPlugins([]);
		}
		entry.wiredMode = mode;
		this.applyVolume(entry);
		this.applyPosition(entry);
	}

	private unwire(entry: SpatialTrack): void {
		entry.panner?.disconnect();
		entry.sendGain?.disconnect();
		entry.muteGain?.disconnect();
		if (entry.resonanceSource) this.freeResonanceSources.push(entry.resonanceSource);
		entry.panner = entry.sendGain = entry.muteGain = entry.resonanceSource = undefined;
		entry.wiredMode = SpatialAudioMode.OFF;
	}

	private applyVolume(entry: SpatialTrack): void {
		if (entry.sendGain) {
			entry.sendGain.gain.setTargetAtTime(entry.volume, this.audioContext.currentTime, 0.05);
		} else {
			entry.track.setVolume(entry.volume);
		}
	}

	private applyPosition(entry: SpatialTrack): void {
		if (!entry.panner && !entry.resonanceSource) return;
		const { x, y, z } = this.toListenerSpace(this.placements.get(entry.key));
		if (entry.panner) {
			// Glide to the new position so tiles moving in the layout don't click.
			const t = this.audioContext.currentTime;
			entry.panner.positionX.setTargetAtTime(x, t, 0.1);
			entry.panner.positionY.setTargetAtTime(y, t, 0.1);
			entry.panner.positionZ.setTargetAtTime(z, t, 0.1);
		}
		entry.resonanceSource?.setPosition(x, y, z);
	}

	/**
	 * Maps a screen position to a point around the listener (who faces -z with +x to the right, as both Web
	 * Audio and Resonance Audio define it): the top of the layout is in front, the bottom behind.
	 */
	private toListenerSpace(placement: SpatialPlacement | undefined): { x: number; y: number; z: number } {
		const { x, y } = placement ?? { x: 0, y: 1 };
		const azimuth = Math.hypot(x, y) < SpatialAudioService.CENTRE_RADIUS ? 0 : Math.atan2(x, y);
		return {
			x: Math.sin(azimuth) * SpatialAudioService.DISTANCE,
			y: 0,
			z: -Math.cos(azimuth) * SpatialAudioService.DISTANCE
		};
	}

	/** Loads Resonance Audio on first use and creates the scene (a 6 x 3 x 6 m, fairly damped room). */
	private loadResonance(): void {
		if (this.sceneLoading) return;
		this.sceneLoading = true;
		const ctx = this.audioContext;
		// @ts-expect-error resonance-audio ships no type declarations (see ResonanceScene above)
		import('resonance-audio')
			.then((module: any) => {
				const ResonanceAudio = module.ResonanceAudio ?? module.default?.ResonanceAudio;
				if (ctx !== this.context) return;
				const scene: ResonanceScene = new ResonanceAudio(ctx, {
					ambisonicOrder: 3,
					dimensions: { width: 6, height: 3, depth: 6 },
					materials: {
						left: 'plywood-panel',
						right: 'plywood-panel',
						front: 'curtain-heavy',
						back: 'curtain-heavy',
						down: 'parquet-on-concrete',
						up: 'acoustic-ceiling-tiles'
					}
				});
				scene.output.connect(ctx.destination);
				this.scene = scene;
				this.sceneReady.set(true);
			})
			.catch((error: unknown) => {
				this.log.e('Could not load Resonance Audio, falling back to the PannerNode', error);
				this.sceneLoading = false;
				this.setMode(SpatialAudioMode.PANNER);
			});
	}

	private readStoredMode(): SpatialAudioMode {
		const stored = this.storage.getSpatialAudioMode() as SpatialAudioMode | null;
		return stored && Object.values(SpatialAudioMode).includes(stored) ? stored : SpatialAudioMode.OFF;
	}
}
