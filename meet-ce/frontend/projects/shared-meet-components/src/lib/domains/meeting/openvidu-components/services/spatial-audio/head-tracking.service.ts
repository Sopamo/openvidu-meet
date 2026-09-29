import { inject, Injectable, signal } from '@angular/core';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { AssetsService } from '../../../../../shared/services/assets.service';
import { ILogger } from '../../models/logger.model';
import { DeviceService } from '../device/device.service';
import { LoggerService } from '../logger/logger.service';

const MODEL = 'assets/mediapipe/face_landmarker.task';
const WASM = 'assets/mediapipe/wasm';
/** Face mesh landmarks on the two cheeks, next to the ears. */
const CHEEKS = [234, 454] as const;
/** Without a face for this long, the head is assumed to face the screen again. */
const LOST_FACE_MS = 1000;
const MAX_YAW = (80 * Math.PI) / 180;

/**
 * @internal
 *
 * Camera-based head tracking for spatial audio: how far the user's head is turned left or right (yaw).
 *
 * MediaPipe Face Landmarker (GPU, in the browser) finds the face mesh in a small, separate camera stream; the
 * yaw follows from the depth of the two cheeks: when the head turns to the user's left, their left cheek moves
 * away from the camera. The camera frames never leave the browser. The camera is assumed to sit at the top
 * centre of the screen, so looking at the middle of the screen is yaw 0.
 */
@Injectable({
	providedIn: 'root'
})
export class HeadTrackingService {
	private readonly assets = inject(AssetsService);
	private readonly deviceService = inject(DeviceService);
	private readonly log: ILogger = inject(LoggerService).get('HeadTrackingService');

	/** Whether the camera is being read and a face is found. */
	readonly tracking = signal(false);
	/** Set when head tracking could not start (e.g. no camera permission). */
	readonly error = signal<string | undefined>(undefined);

	/** Called with the head's yaw in radians (positive: turned to the right), for every analysed frame. */
	onYaw: (yaw: number) => void = () => {};

	private running = false;
	private stream?: MediaStream;
	private video?: HTMLVideoElement;
	private landmarker?: FaceLandmarker;
	private frameRequest?: number;
	private lastFaceAt = 0;
	private readonly filter = new OneEuroFilter(1.5, 0.3);

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.error.set(undefined);
		try {
			const deviceId = this.deviceService.getCameraSelected()?.device;
			const stream = await navigator.mediaDevices.getUserMedia({
				video: {
					...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
					width: { ideal: 320 },
					height: { ideal: 240 },
					frameRate: { ideal: 30 }
				}
			});
			if (!this.running) return stream.getTracks().forEach((t) => t.stop());
			this.stream = stream;

			const video = document.createElement('video');
			video.muted = true;
			video.playsInline = true;
			video.srcObject = stream;
			await video.play();
			this.video = video;

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
			this.scheduleFrame();
		} catch (error) {
			this.log.w('Head tracking could not start', error);
			this.error.set(error instanceof Error ? error.message : String(error));
			this.stop();
		}
	}

	stop(): void {
		this.running = false;
		if (this.frameRequest !== undefined) this.video?.cancelVideoFrameCallback(this.frameRequest);
		this.frameRequest = undefined;
		this.landmarker?.close();
		this.landmarker = undefined;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = undefined;
		if (this.video) this.video.srcObject = null;
		this.video = undefined;
		this.filter.reset();
		this.tracking.set(false);
		this.onYaw(0);
	}

	/** Analyses each new camera frame (at most the camera's frame rate, nothing when it doesn't change). */
	private scheduleFrame(): void {
		const video = this.video;
		if (!this.running || !video) return;
		this.frameRequest = video.requestVideoFrameCallback((now) => {
			this.analyse(now);
			this.scheduleFrame();
		});
	}

	private analyse(now: number): void {
		const landmarker = this.landmarker;
		const video = this.video;
		if (!landmarker || !video) return;
		const face = landmarker.detectForVideo(video, now).faceLandmarks[0];
		if (!face) {
			if (now - this.lastFaceAt > LOST_FACE_MS && this.tracking()) {
				this.tracking.set(false);
				this.filter.reset();
				this.onYaw(0);
			}
			return;
		}
		this.lastFaceAt = now;
		if (!this.tracking()) this.tracking.set(true);

		// Landmark x and z share a scale (the image width), so the cheek-to-cheek vector gives the yaw. Which
		// landmark is which doesn't matter: the cheek on the image's right moving away means the head turned to
		// the user's left (the camera image is not mirrored).
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
