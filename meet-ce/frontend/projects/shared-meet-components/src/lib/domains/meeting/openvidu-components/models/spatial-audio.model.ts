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
	/** Google Resonance Audio: ambisonic HRTF rendering plus a small virtual room (early reflections, reverb). */
	RESONANCE = 'resonance'
}

/** @internal Documentation of the rendering engines, linked from the settings panel. */
export const SPATIAL_AUDIO_DOCS: Record<Exclude<SpatialAudioMode, SpatialAudioMode.OFF>, string> = {
	[SpatialAudioMode.PANNER]: 'https://developer.mozilla.org/en-US/docs/Web/API/PannerNode',
	[SpatialAudioMode.RESONANCE]: 'https://resonance-audio.github.io/resonance-audio/develop/web/getting-started.html'
};

/**
 * @internal
 *
 * Where a stream sits on screen relative to the listener (the local camera, or the screen share when one is
 * shown), in half-widths / half-heights of the layout, `y` pointing up: above the listener means in front, left
 * means left and below means behind.
 */
export interface SpatialPlacement {
	x: number;
	y: number;
}
