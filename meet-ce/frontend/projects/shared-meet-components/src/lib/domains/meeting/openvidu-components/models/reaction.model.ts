/**
 * @internal
 *
 * comeet: meeting reactions. Everyone can send one of these; it floats up on every participant's
 * screen with the sender's name and a short sound. Images are the team's Slack emoji, sounds were
 * generated for them with ElevenLabs.
 */
export interface MeetingReaction {
	id: string;
	/** Image file in assets/reactions/ */
	file: string;
	/** Sound effect in assets/reactions/ (generated with ElevenLabs sound effects, loudness-normalised). */
	sound: string;
	/** Small pixel-art source: scale up with crisp pixels instead of blurring. */
	pixelated?: boolean;
}

export const REACTIONS: readonly MeetingReaction[] = [
	{ id: 'ugly-rotate', file: 'ugly-rotate.gif', pixelated: true, sound: 'ugly-rotate.mp3' },
	{ id: 'partyparrot', file: 'partyparrot.gif', sound: 'partyparrot.mp3' },
	{ id: 'pepe-happy', file: 'pepe-happy.png', pixelated: true, sound: 'pepe-happy.mp3' },
	{ id: 'pepe-sad', file: 'pepe-sad.webp', sound: 'pepe-sad.mp3' },
	{ id: 'ugly-pray', file: 'ugly-pray.gif', pixelated: true, sound: 'ugly-pray.mp3' },
	{ id: 'trollface', file: 'trollface.png', sound: 'trollface.mp3' },
	{ id: 'janusz', file: 'janusz.png', sound: 'janusz.mp3' }
];

/** Payload sent on {@link DataTopic.REACTION}. */
export interface ReactionSignalPayload {
	reaction: string;
}

/** A reaction currently floating on screen. */
export interface ActiveReaction {
	key: number;
	reaction: MeetingReaction;
	participantName: string;
	isLocal: boolean;
	/** Horizontal offset in px from the left edge of the overlay lane. */
	offset: number;
	/** Duration of the float animation in ms (slightly randomised so bursts spread out). */
	duration: number;
}
