/**
 * @internal
 *
 * How remote voices are rendered for the local user (a local choice, nothing is sent to the room).
 */
export enum SpatialAudioMode {
	/** Plain stereo mix, the default. */
	OFF = 'off',
	/** Web Audio `PannerNode` with the browser's built-in HRTF. */
	PANNER = 'panner',
	/** Measured HRTFs of TH Köln (Neumann KU100 dummy head, source 1.5 m away), convolved per voice. */
	THK = 'thk'
}

/** @internal Documentation linked from the settings panel. */
export const SPATIAL_AUDIO_DOCS = {
	panner: 'https://developer.mozilla.org/en-US/docs/Web/API/PannerNode',
	thk: 'https://sofacoustics.org/data/database/thk/',
	headTracking: 'https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker'
} as const;

/**
 * @internal
 *
 * Assumed viewing geometry: the user sits this far in front of the middle of a screen this wide (a 30" 16:9
 * monitor), so a tile's direction is the real angle between the user's head and that spot on the screen.
 */
export const SPATIAL_AUDIO_GEOMETRY = {
	viewingDistanceCm: 60,
	screenWidthCm: 66.4
} as const;

/** @internal Range of the user's "spread" factor for the directions (1 = physically accurate). */
export const SPATIAL_AUDIO_SPREAD = { min: 1, max: 4, step: 0.25, default: 1 } as const;

/**
 * @internal
 *
 * Where a remote stream's tile is: the horizontal position of its centre on the physical screen, in CSS pixels
 * from the screen's left edge (the same unit as `window.screen.width`).
 */
export interface SpatialPlacement {
	screenX: number;
}

/**
 * @internal
 *
 * Debug view of one voice's direction, in degrees (positive: right): the direction it is played from, made of
 * the tile's direction (times the spread) minus the head's yaw.
 */
export interface SpatialAngle {
	azimuth: number;
	tile: number;
	head: number;
}
