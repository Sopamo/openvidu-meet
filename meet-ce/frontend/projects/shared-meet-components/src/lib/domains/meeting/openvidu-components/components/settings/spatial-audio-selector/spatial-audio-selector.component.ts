import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { SPATIAL_AUDIO_DOCS, SPATIAL_AUDIO_SPREAD, SpatialAudioMode } from '../../../models/spatial-audio.model';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { HeadTrackingService } from '../../../services/spatial-audio/head-tracking.service';
import { SpatialAudioService } from '../../../services/spatial-audio/spatial-audio.service';

/**
 * @internal
 *
 * Dropdown for the local spatial audio mode (off, Web Audio PannerNode, TH Köln HRTFs).
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
		[SpatialAudioMode.THK]: 'PANEL.SETTINGS.SPATIAL_AUDIO_THK'
	};
	protected readonly mode = this.spatialAudio.mode;

	setMode(mode: SpatialAudioMode): void {
		this.spatialAudio.setMode(mode);
	}
}

/**
 * @internal
 *
 * Under the selector: what spatial audio does and, while it is on, the spread of the directions and head
 * tracking, with links to the documentation and the source of the HRTFs.
 */
@Component({
	selector: 'ov-spatial-audio-options',
	imports: [MatIconModule, MatSliderModule, MatSlideToggleModule, TranslatePipe],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
		<div class="spatial-audio-options">
			<p class="hint">
				{{ 'PANEL.SETTINGS.SPATIAL_AUDIO_HINT' | translate }}
				{{ 'PANEL.SETTINGS.SPATIAL_AUDIO_DOCS' | translate }}:
				<a [href]="docs.panner" target="_blank" rel="noopener noreferrer">PannerNode</a>,
				<a [href]="docs.thk" target="_blank" rel="noopener noreferrer">TH Köln KU100 HRTF (CC BY-SA 3.0)</a>,
				<a [href]="docs.headTracking" target="_blank" rel="noopener noreferrer">MediaPipe Face Landmarker</a>
			</p>
			@if (enabled()) {
				<div class="row">
					<span class="label">{{ 'PANEL.SETTINGS.SPATIAL_AUDIO_SPREAD' | translate }}</span>
					<mat-slider class="spread-slider" [min]="spreadRange.min" [max]="spreadRange.max" [step]="spreadRange.step">
						<input
							matSliderThumb
							id="spatial-audio-spread"
							[value]="spread()"
							(input)="setSpread($any($event.target).value)"
							[attr.aria-label]="'PANEL.SETTINGS.SPATIAL_AUDIO_SPREAD' | translate"
						/>
					</mat-slider>
					<span class="value">{{ spreadLabel() }}</span>
				</div>
				<p class="hint">{{ 'PANEL.SETTINGS.SPATIAL_AUDIO_SPREAD_HINT' | translate }}</p>
				<div class="row">
					<mat-slide-toggle
						id="spatial-audio-head-tracking"
						[checked]="headTracking()"
						(change)="setHeadTracking($event.checked)"
					>
						{{ 'PANEL.SETTINGS.HEAD_TRACKING' | translate }}
					</mat-slide-toggle>
					@if (headTracking() && statusKey(); as key) {
						<span class="status" [class.active]="status() === 'tracking'">
							{{ key | translate }}@if (status() === 'tracking' && cameraLabel()) {
								({{ cameraLabel() }})
							}
						</span>
					}
				</div>
				<p class="hint">{{ 'PANEL.SETTINGS.HEAD_TRACKING_HINT' | translate }}</p>
				<div class="row">
					<mat-slide-toggle id="spatial-audio-debug" [checked]="debug()" (change)="setDebug($event.checked)">
						{{ 'PANEL.SETTINGS.SPATIAL_AUDIO_DEBUG' | translate }}
					</mat-slide-toggle>
				</div>
				<p class="hint">{{ 'PANEL.SETTINGS.SPATIAL_AUDIO_DEBUG_HINT' | translate }}</p>
			}
		</div>
	`,
	styles: `
		.spatial-audio-options {
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 0 16px;
			color: var(--ov-text-surface-color);
		}
		.hint {
			margin: 0;
			font-size: 12px;
			line-height: 1.4;
			opacity: 0.8;

			a {
				color: inherit;
				text-decoration: underline;
			}
		}
		.row {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-top: 8px;
		}
		.label {
			font-size: 14px;
			white-space: nowrap;
		}
		.spread-slider {
			flex: 1;
			min-width: 120px;
		}
		.value {
			font-variant-numeric: tabular-nums;
			min-width: 3em;
			text-align: right;
		}
		.status {
			font-size: 12px;
			opacity: 0.7;

			&.active {
				opacity: 1;
				color: var(--ov-accent-action-color);
			}
		}
	`,
	standalone: true
})
export class SpatialAudioOptionsComponent {
	private readonly spatialAudio = inject(SpatialAudioService);
	private readonly headTrackingService = inject(HeadTrackingService);

	protected readonly docs = SPATIAL_AUDIO_DOCS;
	protected readonly spreadRange = SPATIAL_AUDIO_SPREAD;
	protected readonly enabled = this.spatialAudio.enabled;
	protected readonly spread = this.spatialAudio.spread;
	protected readonly spreadLabel = computed(() => `${this.spread().toFixed(2).replace(/\.?0+$/, '')}×`);
	protected readonly headTracking = this.spatialAudio.headTrackingEnabled;
	protected readonly debug = this.spatialAudio.debug;
	protected readonly status = this.headTrackingService.status;
	protected readonly cameraLabel = this.headTrackingService.cameraLabel;
	protected readonly statusKey = computed(
		() =>
			({
				off: '',
				starting: 'PANEL.SETTINGS.HEAD_TRACKING_STARTING',
				searching: 'PANEL.SETTINGS.HEAD_TRACKING_SEARCHING',
				tracking: 'PANEL.SETTINGS.HEAD_TRACKING_ACTIVE',
				error: 'PANEL.SETTINGS.HEAD_TRACKING_ERROR'
			})[this.status()]
	);

	setSpread(value: string | number): void {
		this.spatialAudio.setSpread(Number(value));
	}

	setHeadTracking(enabled: boolean): void {
		this.spatialAudio.setHeadTracking(enabled);
	}

	setDebug(enabled: boolean): void {
		this.spatialAudio.setDebug(enabled);
	}
}
