/**
 * @internal
 *
 * comeet: meeting reactions. Everyone can send one of these; it floats up on every participant's
 * screen with the sender's name and a short sound. Images are the team's Slack emoji.
 */
export interface MeetingReaction {
	id: string;
	/** File in assets/reactions/ */
	file: string;
	/** Small pixel-art source: scale up with crisp pixels instead of blurring. */
	pixelated?: boolean;
}

export const REACTIONS: readonly MeetingReaction[] = [
	{ id: 'ugly-rotate', file: 'ugly-rotate.gif', pixelated: true },
	{ id: 'partyparrot', file: 'partyparrot.gif' },
	{ id: 'pepe-happy', file: 'pepe-happy.png', pixelated: true },
	{ id: 'pepe-sad', file: 'pepe-sad.webp' },
	{ id: 'ugly-pray', file: 'ugly-pray.gif', pixelated: true },
	{ id: 'trollface', file: 'trollface.png' },
	{ id: 'janusz', file: 'janusz.png' }
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
