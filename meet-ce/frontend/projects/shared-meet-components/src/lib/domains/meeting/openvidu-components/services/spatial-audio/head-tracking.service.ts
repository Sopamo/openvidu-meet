import { inject, Injectable, Injector, signal } from '@angular/core';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { AssetsService } from '../../../../../shared/services/assets.service';
import { ILogger } from '../../models/logger.model';
import { DeviceService } from '../device/device.service';
import { Track } from '../livekit-adapter';
import { LoggerService } from '../logger/logger.service';
import { OpenViduService } from '../openvidu/openvidu.service';

const MODEL = 'assets/mediapipe/face_landmarker.task';
const WASM = 'assets/mediapipe/wasm';
/** Face mesh landmarks on the two cheeks, next to the ears. */
const CHEEKS = [234, 454] as const;
/** A camera that shows no face for this long is swapped for the next one while searching. */
const SEARCH_MS = 2500;
/** After losing the face for this long, the head is assumed to face the screen and the search starts again. */
const LOST_FACE_MS = 1000;
const RESEARCH_MS = 10000;
const MAX_YAW = (80 * Math.PI) / 180;

/** @internal State of head tracking, shown in the settings. */
export type HeadTrackingStatus = 'off' | 'starting' | 'searching' | 'tracking' | 'error';

/** A camera to try: the published camera track (copied) or a device opened just for head tracking. */
interface CameraSource {
	label: string;
	open: () => Promise<MediaStream>;
}

/**
 * @internal
 *
 * Camera-based head tracking for spatial audio: how far the user's head is turned left or right (yaw).
 *
 * MediaPipe Face Landmarker (GPU, in the browser) finds the face mesh in a small camera stream; the yaw follows
 * from the depth of the two cheeks: when the head turns to the user's left, their left cheek moves away from the
 * camera. The camera frames never leave the browser. The camera is assumed to sit at the top centre of the
 * screen, so looking at the middle of the screen is yaw 0.
 *
 * The camera the user faces: a copy of the camera track they publish (no second capture), else the selected and
 * then every other camera, each tried until one shows a face (people often have several cameras).
 */
@Injectable({
	providedIn: 'root'
})
export class HeadTrackingService {
	private readonly assets = inject(AssetsService);
	private readonly deviceService = inject(DeviceService);
	// OpenViduService depends (through SpatialAudioService) on this service, so it is looked up when needed.
	private readonly injector = inject(Injector);
	private readonly log: ILogger = inject(LoggerService).get('HeadTrackingService');

	readonly status = signal<HeadTrackingStatus>('off');
	/** The camera in use while tracking. */
	readonly cameraLabel = signal<string | undefined>(undefined);

	/** Called with the head's yaw in radians (positive: turned to the right), for every analysed frame. */
	onYaw: (yaw: number) => void = () => {};

	private running = false;
	private landmarker?: FaceLandmarker;
	private sources: CameraSource[] = [];
	private sourceIndex = -1;
	private stream?: MediaStream;
	private video?: HTMLVideoElement;
	private frameRequest?: number;
	private sourceStartedAt = 0;
	private lastFaceAt = 0;
	private foundFace = false;
	private switching = false;
	private readonly filter = new OneEuroFilter(1.5, 0.3);

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.status.set('starting');
		try {
			const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
			const fileset = await FilesetResolver.forVisionTasks(this.assets.resolve(WASM));
			const landmarker = await FaceLandmarker.createFromOptions(fileset, {
				baseOptions: { modelAssetPath: this.assets.resolve(MODEL), delegate: 'GPU' },
				runningMode: 'VIDEO',
				numFaces: 1,
				outputFaceBlendshapes: false,
				outputFacialTransformationMatrixes: false
			});
			if (!this.running) return landmarker.close();
			this.landmarker = landmarker;
			this.sources = await this.cameraSources();
			if (!this.sources.length) throw new Error('No camera');
			await this.nextSource();
		} catch (error) {
			this.log.w('Head tracking could not start', error);
			this.stop();
			this.status.set('error');
		}
	}

	stop(): void {
		this.running = false;
		this.closeSource();
		this.landmarker?.close();
		this.landmarker = undefined;
		this.sources = [];
		this.sourceIndex = -1;
		this.status.set('off');
		this.cameraLabel.set(undefined);
		this.onYaw(0);
	}

	/** The published camera first (if on), then the selected camera, then all other cameras. */
	private async cameraSources(): Promise<CameraSource[]> {
		const sources: CameraSource[] = [];
		let publishedDeviceId: string | undefined;
		const openvidu = this.injector.get(OpenViduService);
		if (openvidu.isRoomInitialized()) {
			const track = openvidu.getRoom().localParticipant.getTrackPublication(Track.Source.Camera)?.track;
			const media = track?.mediaStreamTrack;
			if (media && media.readyState === 'live' && !track.isMuted) {
				publishedDeviceId = media.getSettings().deviceId;
				sources.push({ label: media.label, open: async () => new MediaStream([media.clone()]) });
			}
		}
		const selected = this.deviceService.getCameraSelected()?.device;
		const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
		devices.sort((a, b) => Number(b.deviceId === selected) - Number(a.deviceId === selected));
		for (const device of devices) {
			if (device.deviceId && device.deviceId === publishedDeviceId) continue;
			sources.push({
				label: device.label,
				open: () =>
					navigator.mediaDevices.getUserMedia({
						video: {
							...(device.deviceId ? { deviceId: { exact: device.deviceId } } : {}),
							width: { ideal: 320 },
							height: { ideal: 240 },
							frameRate: { ideal: 30 }
						}
					})
			});
		}
		return sources;
	}

	/** Switches to the next camera (round robin) and analyses its frames. */
	private async nextSource(): Promise<void> {
		if (this.switching || !this.running || !this.sources.length) return;
		this.switching = true;
		try {
			this.closeSource();
			for (let tries = 0; tries < this.sources.length && this.running; tries++) {
				this.sourceIndex = (this.sourceIndex + 1) % this.sources.length;
				const source = this.sources[this.sourceIndex];
				try {
					const stream = await source.open();
					if (!this.running) return stream.getTracks().forEach((t) => t.stop());
					const video = document.createElement('video');
					video.muted = true;
					video.playsInline = true;
					video.srcObject = stream;
					await video.play();
					this.stream = stream;
					this.video = video;
					this.cameraLabel.set(source.label || undefined);
					this.sourceStartedAt = performance.now();
					this.foundFace = false;
					if (this.status() !== 'tracking') this.status.set('searching');
					this.scheduleFrame();
					return;
				} catch (error) {
					this.log.w(`Camera "${source.label}" could not be opened for head tracking`, error);
				}
			}
			throw new Error('No camera could be opened');
		} catch (error) {
			this.log.w('Head tracking has no camera', error);
			this.status.set('error');
		} finally {
			this.switching = false;
		}
	}

	private closeSource(): void {
		if (this.frameRequest !== undefined) this.video?.cancelVideoFrameCallback(this.frameRequest);
		this.frameRequest = undefined;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = undefined;
		if (this.video) this.video.srcObject = null;
		this.video = undefined;
		this.filter.reset();
	}

	/** Analyses each new camera frame (at most the camera's frame rate, nothing when it doesn't change). */
	private scheduleFrame(): void {
		const video = this.video;
		if (!this.running || !video) return;
		this.frameRequest = video.requestVideoFrameCallback((now) => {
			if (video !== this.video) return;
			this.analyse(now);
			if (video === this.video) this.scheduleFrame();
		});
	}

	private analyse(now: number): void {
		const landmarker = this.landmarker;
		const video = this.video;
		if (!landmarker || !video) return;
		const face = landmarker.detectForVideo(video, now).faceLandmarks[0];
		if (!face) {
			const sinceFace = now - this.lastFaceAt;
			if (this.status() === 'tracking' && sinceFace > LOST_FACE_MS) {
				this.status.set('searching');
				this.filter.reset();
				this.onYaw(0);
			}
			// No face on this camera (yet, or for a while): try the next one.
			const searchedLongEnough = this.foundFace ? sinceFace > RESEARCH_MS : now - this.sourceStartedAt > SEARCH_MS;
			if (searchedLongEnough && this.sources.length > 1) void this.nextSource();
			return;
		}
		this.lastFaceAt = now;
		this.foundFace = true;
		if (this.status() !== 'tracking') this.status.set('tracking');

		// Landmark x and z share a scale (the image width), so the cheek-to-cheek vector gives the yaw. Which
		// landmark is which doesn't matter: the cheek on the image's right moving away means the head turned to
		// the user's left (camera images are not mirrored).
		const a = face[CHEEKS[0]];
		const b = face[CHEEKS[1]];
		const dx = b.x - a.x;
		const dz = b.z - a.z;
		const turnedLeft = Math.atan2(dz * Math.sign(dx || 1), Math.abs(dx));
		const yaw = Math.max(-MAX_YAW, Math.min(MAX_YAW, -turnedLeft));
		this.onYaw(this.filter.filter(yaw, now / 1000));
	}
}

/**
 * One-Euro filter (Casiez et al. 2012): smooths jitter while the head is still, follows quickly when it moves.
 */
class OneEuroFilter {
	private x?: number;
	private dx = 0;
	private t = 0;

	constructor(
		private readonly minCutoff: number,
		private readonly beta: number,
		private readonly dCutoff = 1
	) {}

	reset(): void {
		this.x = undefined;
		this.dx = 0;
	}

	filter(value: number, time: number): number {
		if (this.x === undefined) {
			this.x = value;
			this.t = time;
			return value;
		}
		const dt = Math.max(1e-3, time - this.t);
		this.t = time;
		const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
		const rawDx = (value - this.x) / dt;
		this.dx += alpha(this.dCutoff) * (rawDx - this.dx);
		this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx)) * (value - this.x);
		return this.x;
	}
}
