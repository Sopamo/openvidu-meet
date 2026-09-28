import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AssetsService } from '../../../../../shared/services/assets.service';
import { REACTIONS } from '../../models/reaction.model';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { ReactionService } from '../../services/reaction/reaction.service';

/**
 * @internal
 *
 * comeet: toolbar button opening a bar of reactions. The bar stays open so several reactions can be
 * sent in a row; it closes on a click outside or Escape.
 */
@Component({
	selector: 'ov-reaction-picker',
	imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslatePipe],
	template: `
		<button
			mat-icon-button
			id="reactions-btn"
			[matMenuTriggerFor]="reactionsMenu"
			[disabled]="disabled()"
			[class.mobile-btn]="mobile()"
			[matTooltip]="'TOOLBAR.REACTIONS' | translate"
		>
			<mat-icon>add_reaction</mat-icon>
		</button>
		<mat-menu #reactionsMenu="matMenu" class="ov-reactions-menu" yPosition="above" xPosition="after">
			<div class="reactions-bar" (click)="$event.stopPropagation()">
				@for (reaction of reactions; track reaction.id) {
					<button
						type="button"
						class="reaction-option"
						[id]="'reaction-' + reaction.id"
						[attr.aria-label]="reaction.id"
						[title]="':' + reaction.id + ':'"
						(click)="reactionService.send(reaction.id)"
					>
						<img
							[src]="assets.reactionImage(reaction.file)"
							[alt]="reaction.id"
							[class.pixelated]="reaction.pixelated"
						/>
					</button>
				}
			</div>
		</mat-menu>
	`,
	styles: `
		::ng-deep .ov-reactions-menu.mat-mdc-menu-panel {
			max-width: none;
			border-radius: 16px;
		}
		.reactions-bar {
			display: flex;
			gap: 2px;
			padding: 4px 6px;
		}
		.reaction-option {
			width: 44px;
			height: 44px;
			padding: 6px;
			border: 0;
			border-radius: 10px;
			background: transparent;
			cursor: pointer;
			transition: transform 0.12s ease, background-color 0.12s ease;
		}
		.reaction-option:hover,
		.reaction-option:focus-visible {
			background: rgba(127, 127, 127, 0.18);
			transform: scale(1.18);
			outline: none;
		}
		.reaction-option:active {
			transform: scale(0.95);
		}
		.reaction-option img {
			width: 100%;
			height: 100%;
			object-fit: contain;
		}
		.reaction-option img.pixelated {
			image-rendering: pixelated;
		}
	`,
	changeDetection: ChangeDetectionStrategy.OnPush,
	standalone: true
})
export class ReactionPickerComponent {
	readonly disabled = input(false);
	readonly mobile = input(false);
	readonly reactions = REACTIONS;
	readonly reactionService = inject(ReactionService);
	readonly assets = inject(AssetsService);
}
