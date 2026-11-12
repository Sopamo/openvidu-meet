import { inject, Injectable, signal } from '@angular/core';
import { AssetsService } from '../../../../../shared/services/assets.service';
import { ILogger } from '../../models/logger.model';
import { AudioProcessorOptions, OVLocalAudioTrack, Track, TrackProcessor } from '../livekit-adapter';
import { LoggerService } from '../logger/logger.service';
import { PlatformService } from '../platform/platform.service';
import { StorageService } from '../storage/storage.service';

/** Self-hosted DeepFilterNet3 runtime, see meet-ce/frontend/scripts/build-deepfilternet.sh. */
const ASSET_DIR = 'assets/deepfilternet';
const PROCESSOR_NAME = 'comeet-deepfilter';
/** DeepFilterNet works on 48 kHz audio. */
const SAMPLE_RATE = 48000;
/**
 * The strength setting is DeepFilterNet's attenuation limit: how far noise may be attenuated, in dB. The filter mixes
 * the original signal back in at that many dB below its level, so speech it mistakes for noise is never removed
 * completely, and the artifacts of the enhanced signal are masked (Iwamoto et al., "How Bad Are Artifacts?", Interspeech 2022: adding
 * back a scaled observation reduces the artifact error). 100 dB means no limit (upstream's default).
 */
export const NOISE_SUPPRESSION_STRENGTHS = [6, 9, 12, 15, 20, 25, 30, 40, 100] as const;
const DEFAULT_STRENGTH_DB = 20;

/**
 * Local SNR thresholds (dB) at which DeepFilterNet switches its stages per 10 ms frame. Upstream's defaults
 * (-10, 30, 20) return a silent frame below -10 dB, which cut off quiet syllables and word endings, and switch the
 * stages on and off between frames, which is audible. The model estimates the SNR within [-15, 35], so these values
 * (the defaults of upstream's LADSPA plugin for live calls) always run both stages and never return silence.
 */
const SNR_THRESHOLDS = { minDb: -15, maxErbDb: 35, maxDfDb: 35 };

interface DeepFilterAssets {
	wasmModule: WebAssembly.Module;
	modelBytes: ArrayBuffer;
}

/**
 * @internal
 *
 * comeet: LiveKit audio processor that runs the microphone through DeepFilterNet3 (an AudioWorklet with the WASM
 * build of upstream libDF) before it is sent. LiveKit swaps the sender's track for {@link processedTrack}.
 */
class DeepFilterNoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
	readonly name = PROCESSOR_NAME;
	processedTrack?: MediaStreamTrack;

	private source?: MediaStreamAudioSourceNode;
	node?: AudioWorkletNode;
	private destination?: MediaStreamAudioDestinationNode;

	constructor(
		private readonly context: AudioContext,
		private readonly createNode: (context: AudioContext) => Promise<AudioWorkletNode>
	) {}

	init = async (opts: AudioProcessorOptions): Promise<void> => {
		this.node = await this.createNode(this.context);
		this.destination = this.context.createMediaStreamDestination();
		this.node.connect(this.destination);
		this.processedTrack = this.destination.stream.getAudioTracks()[0];
		this.connectSource(opts.track);
	};

	/** Called by LiveKit when the microphone track is replaced (device switch, restartTrack). */
	restart = async (opts: AudioProcessorOptions): Promise<void> => {
		this.connectSource(opts.track);
	};

	destroy = async (): Promise<void> => {
		this.source?.disconnect();
		this.node?.disconnect();
		this.node?.port.close();
		this.processedTrack?.stop();
		this.source = this.node = this.destination = this.processedTrack = undefined;
	};

	private connectSource(track: MediaStreamTrack): void {
		this.source?.disconnect();
		this.source = this.context.createMediaStreamSource(new MediaStream([track]));
		this.source.connect(this.node!);
	}
}

/**
 * Manages AI noise suppression on the local microphone track (DeepFilterNet3, running in the browser).
 *
 * Responsibilities:
 * - The user's on/off setting (persisted in the browser; on by default except on phones)
 * - Attaching/removing the processor on the current microphone track
 * - Loading the WASM runtime and model once (on first use) and sharing one 48 kHz AudioContext
 * - Turning the browser's own noise suppression off while ours runs, so audio isn't cleaned twice
 *
 * @internal
 */
@Injectable({
	providedIn: 'root'
})
export class AudioTrackProcessorService {
	private readonly log: ILogger = inject(LoggerService).get('AudioTrackProcessorService');
	private readonly storage = inject(StorageService);
	private readonly assets = inject(AssetsService);
	private readonly platform = inject(PlatformService);

	private readonly _isSupported = signal(
		typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined'
	);
	/** False when the browser can't run the filter or it failed to start. */
	readonly isSupported = this._isSupported.asReadonly();

	private readonly _enabled = signal(this.storage.getNoiseSuppression() ?? !this.platform.isPhysicalMobile());
	/** The user's setting. */
	readonly enabled = this._enabled.asReadonly();

	private readonly _strength = signal(this.validStrength(this.storage.getNoiseSuppressionStrength()));
	/** How far noise is attenuated, in dB (one of {@link NOISE_SUPPRESSION_STRENGTHS}). */
	readonly strength = this._strength.asReadonly();

	/** The current microphone track. */
	private track?: OVLocalAudioTrack;
	private context?: AudioContext;
	private workletLoaded?: Promise<void>;
	private assetsLoaded?: Promise<DeepFilterAssets>;
	/** Serialises apply() calls so quick toggling or a mic switch can't interleave setProcessor/stopProcessor. */
	private queue: Promise<void> = Promise.resolve();

	/** Whether the filter should run now. */
	private get active(): boolean {
		return this._enabled() && this._isSupported();
	}

	/** The `noiseSuppression` capture constraint for new microphone tracks: the browser's own only while ours is off. */
	get browserNoiseSuppression(): boolean {
		return !this.active;
	}

	async setEnabled(enabled: boolean): Promise<void> {
		this._enabled.set(enabled);
		this.storage.setNoiseSuppression(enabled);
		if (this.track) await this.applyToAudioTrack(this.track);
	}

	/** Changes the strength on the running filter right away. */
	setStrength(db: number): void {
		const strength = this.validStrength(db);
		this._strength.set(strength);
		this.storage.setNoiseSuppressionStrength(strength);
		const processor = this.track?.getProcessor();
		if (processor instanceof DeepFilterNoiseProcessor) {
			processor.node?.port.postMessage({ type: 'attenLimDb', value: strength });
		}
	}

	/**
	 * The microphone audio as the others receive it (after the filter while it runs), for the microphone test in the
	 * settings. Undefined while the microphone is off or muted.
	 */
	sentMicrophoneTrack(): MediaStreamTrack | undefined {
		const track = this.track;
		if (!track || track.isMuted) return undefined;
		const mediaTrack = track.mediaStreamTrack;
		return mediaTrack?.readyState === 'live' ? mediaTrack : undefined;
	}

	private validStrength(db: number | undefined): number {
		return (NOISE_SUPPRESSION_STRENGTHS as readonly number[]).includes(db as number) ? db! : DEFAULT_STRENGTH_DB;
	}

	/**
	 * Attaches or removes the filter on a microphone track according to the setting. Call it for every new
	 * microphone track; it is idempotent. Device switches via `restartTrack` keep the processor (LiveKit calls
	 * its `restart()`).
	 */
	applyToAudioTrack(track: OVLocalAudioTrack): Promise<void> {
		this.track = track;
		this.queue = this.queue.then(() => this.apply(track)).catch(() => {});
		return this.queue;
	}

	private async apply(track: OVLocalAudioTrack): Promise<void> {
		if (track !== this.track) return; // superseded by a newer track
		const attached = track.getProcessor()?.name === PROCESSOR_NAME;
		if (attached === this.active) return;
		// `track.mediaStreamTrack` is the processed track while a processor is attached, so the browser's own
		// suppression is switched while the raw microphone track is exposed: before attaching, after detaching.
		if (attached) {
			await track.stopProcessor();
			await this.setBrowserNoiseSuppression(track, true);
			this.log.d('Noise suppression disabled on microphone track');
			return;
		}
		try {
			await this.setBrowserNoiseSuppression(track, false);
			const context = this.getContext();
			track.setAudioContext(context);
			await track.setProcessor(new DeepFilterNoiseProcessor(context, (ctx) => this.createNode(ctx)));
			this.log.d('Noise suppression enabled on microphone track');
		} catch (error: any) {
			this.log.w('Noise suppression unavailable, using the browser default:', error?.message || error);
			this._isSupported.set(false);
			if (track.getProcessor()?.name === PROCESSOR_NAME) await track.stopProcessor().catch(() => {});
			await this.setBrowserNoiseSuppression(track, true);
		}
	}

	/**
	 * Switches the browser's own noise suppression on the raw microphone track (new tracks get it through the
	 * capture constraint, see {@link browserNoiseSuppression}).
	 */
	private async setBrowserNoiseSuppression(track: OVLocalAudioTrack, enabled: boolean): Promise<void> {
		const mediaTrack = track.mediaStreamTrack;
		if (!mediaTrack || mediaTrack.readyState === 'ended') return;
		if (mediaTrack.getSettings().noiseSuppression === enabled) return;
		try {
			await mediaTrack.applyConstraints({ ...mediaTrack.getConstraints(), noiseSuppression: enabled });
		} catch (error: any) {
			this.log.d('Could not change browser noise suppression:', error?.message || error);
		}
	}

	private getContext(): AudioContext {
		if (this.context && this.context.state !== 'closed') return this.context;
		const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
		this.context = context;
		this.workletLoaded = undefined;
		// Created before a user gesture (e.g. on the pre-join page), the context starts suspended and the processed
		// track would be silent: resume it on the next click or key press (joining is one).
		const resume = () => {
			if (context.state === 'suspended') void context.resume();
			if (context.state !== 'suspended') {
				document.removeEventListener('pointerdown', resume, true);
				document.removeEventListener('keydown', resume, true);
			}
		};
		if (context.state === 'suspended') {
			document.addEventListener('pointerdown', resume, true);
			document.addEventListener('keydown', resume, true);
		}
		return context;
	}

	private async createNode(context: AudioContext): Promise<AudioWorkletNode> {
		this.workletLoaded ??= context.audioWorklet.addModule(this.assets.resolve(`${ASSET_DIR}/deepfilter-worklet.js`));
		this.assetsLoaded ??= this.loadAssets();
		this.assetsLoaded.catch(() => (this.assetsLoaded = undefined)); // retry on the next attempt
		const [, { wasmModule, modelBytes }] = await Promise.all([this.workletLoaded, this.assetsLoaded]);

		const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [1],
			channelCount: 1,
			channelCountMode: 'explicit',
			// The worklet keeps its own copy, so the cached bytes can be reused for the next track.
			processorOptions: {
				wasmModule,
				modelBytes: modelBytes.slice(0),
				attenLimDb: this._strength(),
				thresholds: SNR_THRESHOLDS
			}
		});
		await new Promise<void>((resolve, reject) => {
			node.port.onmessage = ({ data }) => {
				if (data?.type === 'ready') resolve();
				else if (data?.type === 'error') reject(new Error(`DeepFilterNet failed to start: ${data.message}`));
			};
			node.onprocessorerror = () => reject(new Error('DeepFilterNet worklet crashed'));
		});
		node.port.onmessage = null;
		return node;
	}

	private async loadAssets(): Promise<DeepFilterAssets> {
		const fetchBytes = async (file: string) => {
			const response = await fetch(this.assets.resolve(`${ASSET_DIR}/${file}`));
			if (!response.ok) throw new Error(`Failed to load ${file}: ${response.status}`);
			return response.arrayBuffer();
		};
		const started = performance.now();
		const [wasmBytes, modelBytes] = await Promise.all([
			fetchBytes('df_bg.wasm'),
			fetchBytes('DeepFilterNet3_onnx.tar.gz')
		]);
		const wasmModule = await WebAssembly.compile(wasmBytes);
		this.log.d(`DeepFilterNet loaded in ${Math.round(performance.now() - started)} ms`);
		return { wasmModule, modelBytes };
	}
}
