import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssetsService } from '../../../../../shared/services/assets.service';
import { ReactionService } from '../../services/reaction/reaction.service';

/**
 * @internal
 *
 * comeet: reactions floating up from the bottom-left of the meeting, with the sender's name
 * (Google Meet style). Purely visual: it never takes clicks.
 */
@Component({
	selector: 'ov-reactions-overlay',
	template: `
		@for (item of reactionService.active(); track item.key) {
			<div
				class="reaction"
				[style.left.px]="item.offset"
				[style.animation-duration.ms]="item.duration"
			>
				<img
					class="reaction-image"
					[class.pixelated]="item.reaction.pixelated"
					[src]="assets.reactionImage(item.reaction.file)"
					[alt]="item.reaction.id"
				/>
				@if (item.participantName) {
					<span class="reaction-name">{{ item.participantName }}</span>
				}
			</div>
		}
	`,
	styles: `
		:host {
			position: absolute;
			left: 24px;
			bottom: 0;
			width: 220px;
			height: 70%;
			pointer-events: none;
			overflow: visible;
			z-index: 20;
		}
		.reaction {
			position: absolute;
			bottom: 0;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 4px;
			animation-name: reaction-float;
			animation-timing-function: cubic-bezier(0.25, 0.6, 0.4, 1);
			animation-fill-mode: forwards;
			will-change: transform, opacity;
		}
		.reaction-image {
			width: 56px;
			height: 56px;
			object-fit: contain;
			filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35));
		}
		.reaction-image.pixelated {
			image-rendering: pixelated;
		}
		.reaction-name {
			max-width: 140px;
			padding: 2px 8px;
			border-radius: 999px;
			background: rgba(0, 0, 0, 0.6);
			color: #fff;
			font-size: 12px;
			line-height: 18px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		@keyframes reaction-float {
			0% {
				transform: translate(0, 40px) scale(0.4);
				opacity: 0;
			}
			10% {
				transform: translate(0, 0) scale(1.1);
				opacity: 1;
			}
			15% {
				transform: translate(0, -5%) scale(1);
			}
			40% {
				transform: translate(14px, -40%);
			}
			65% {
				transform: translate(-10px, -70%);
				opacity: 1;
			}
			100% {
				transform: translate(6px, -100%);
				opacity: 0;
			}
		}
		@media (prefers-reduced-motion: reduce) {
			.reaction {
				animation-name: reaction-fade;
			}
			@keyframes reaction-fade {
				0%, 80% { opacity: 1; }
				100% { opacity: 0; }
			}
		}
	`,
	changeDetection: ChangeDetectionStrategy.OnPush,
	standalone: true
})
export class ReactionsOverlayComponent {
	readonly reactionService = inject(ReactionService);
	readonly assets = inject(AssetsService);
}
