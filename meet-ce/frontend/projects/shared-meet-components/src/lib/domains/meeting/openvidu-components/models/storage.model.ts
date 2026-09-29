/**
 * @internal
 */
export enum StorageKeys {
	PARTICIPANT_NAME = 'participantName',
	VIDEO_DEVICE = 'videoDevice',
	AUDIO_DEVICE = 'audioDevice',
	MICROPHONE_ENABLED = 'microphoneEnabled',
	CAMERA_ENABLED = 'cameraEnabled',
	LANG = 'lang',
	CAPTION_LANG = 'captionLang',
	BACKGROUND = 'virtualBg',
	THEME = 'theme',
	PARTICIPANT_VOLUMES = 'participantVolumes',
	SPATIAL_AUDIO = 'spatialAudio'
}

/**
 * @internal
 *
 * Keys whose value is scoped to a single browser tab.
 *
 * They are persisted in `sessionStorage`, which is isolated per tab and cleared automatically
 * by the browser when the tab is closed. This lets several tabs join with independent settings
 * (name, camera/microphone state) without leaking state between them. Every other key is stored
 * in `localStorage` and therefore shared across all tabs of the same origin.
 */
export const TAB_SPECIFIC_KEYS: StorageKeys[] = [
	StorageKeys.PARTICIPANT_NAME,
	StorageKeys.MICROPHONE_ENABLED,
	StorageKeys.CAMERA_ENABLED
];

export const STORAGE_PREFIX = 'ovComponents-';
