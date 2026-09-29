import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { SPATIAL_AUDIO_DOCS, SpatialAudioMode } from '../../../models/spatial-audio.model';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { SpatialAudioService } from '../../../services/spatial-audio/spatial-audio.service';

/**
 * @internal
 *
 * Dropdown for the local spatial audio mode (off, Web Audio PannerNode, Resonance Audio), with links to the
 * documentation of both engines.
 */
@Component({
	selector: 'ov-spatial-audio-selector',
	imports: [MatButtonModule, MatIconModule, MatMenuModule, TranslatePipe],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
		<div class="spatial-audio-selector-container">
			<button
				mat-flat-button
				[matMenuTriggerFor]="spatialAudioMenu"
				aria-haspopup="true"
				[attr.aria-label]="'PANEL.SETTINGS.SPATIAL_AUDIO' | translate"
				class="spatial-audio-selector-button"
				id="spatial-audio-selector"
			>
				<span class="spatial-audio-name">
					{{ labelKeys[mode()] | translate }}
					<mat-icon class="expand-icon">expand_more</mat-icon>
				</span>
			</button>

			<mat-menu #spatialAudioMenu="matMenu" class="spatial-audio-menu">
				@for (option of modes; track option) {
					<button
						mat-menu-item
						(click)="setMode(option)"
						[attr.id]="'spatial-audio-' + option"
						[class.selected]="mode() === option"
						class="spatial-audio-option"
					>
						@if (mode() === option) {
							<mat-icon class="check-icon">check</mat-icon>
						}
						<span class="spatial-audio-option-name">{{ labelKeys[option] | translate }}</span>
					</button>
				}
			</mat-menu>
		</div>
	`,
	styleUrl: './spatial-audio-selector.component.scss',
	standalone: true
})
export class SpatialAudioSelectorComponent {
	private readonly spatialAudio = inject(SpatialAudioService);

	protected readonly modes = Object.values(SpatialAudioMode);
	protected readonly labelKeys: Record<SpatialAudioMode, string> = {
		[SpatialAudioMode.OFF]: 'PANEL.SETTINGS.SPATIAL_AUDIO_OFF',
		[SpatialAudioMode.PANNER]: 'PANEL.SETTINGS.SPATIAL_AUDIO_PANNER',
		[SpatialAudioMode.RESONANCE]: 'PANEL.SETTINGS.SPATIAL_AUDIO_RESONANCE'
	};
	protected readonly mode = this.spatialAudio.mode;

	setMode(mode: SpatialAudioMode): void {
		this.spatialAudio.setMode(mode);
	}
}

/**
 * @internal
 *
 * One line under the selector: what spatial audio does and where the two engines are documented.
 */
@Component({
	selector: 'ov-spatial-audio-hint',
	imports: [TranslatePipe],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
		<p class="spatial-audio-hint">
			{{ 'PANEL.SETTINGS.SPATIAL_AUDIO_HINT' | translate }}
			{{ 'PANEL.SETTINGS.SPATIAL_AUDIO_DOCS' | translate }}:
			<a [href]="docs.panner" target="_blank" rel="noopener noreferrer" [class.active]="mode() === 'panner'">PannerNode</a>,
			<a [href]="docs.resonance" target="_blank" rel="noopener noreferrer" [class.active]="mode() === 'resonance'"
				>Resonance Audio</a
			>
		</p>
	`,
	styles: `
		.spatial-audio-hint {
			margin: 0;
			padding: 0 16px;
			font-size: 12px;
			line-height: 1.4;
			color: var(--ov-text-surface-color);
			opacity: 0.8;

			a {
				color: inherit;
				text-decoration: underline;

				&.active {
					font-weight: 600;
				}
			}
		}
	`,
	standalone: true
})
export class SpatialAudioHintComponent {
	private readonly spatialAudio = inject(SpatialAudioService);
	protected readonly docs = SPATIAL_AUDIO_DOCS;
	protected readonly mode = this.spatialAudio.mode;
}
