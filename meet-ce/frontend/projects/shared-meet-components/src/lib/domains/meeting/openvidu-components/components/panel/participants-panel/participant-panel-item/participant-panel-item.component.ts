import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, contentChild, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatSliderModule } from '@angular/material/slider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ParticipantPanelItemElementsDirective } from '../../../../directives/template/openvidu-components-angular.directive';
import { ParticipantPanelParticipantBadgeDirective } from '../../../../directives/template/internals.directive';
import { ParticipantModel } from '../../../../models/participant.model';
import { TranslatePipe } from '../../../../pipes/translate.pipe';
import { OpenViduComponentsConfigService } from '../../../../services/config/directive-config.service';
import { ParticipantVolumeService } from '../../../../services/participant/participant-volume.service';
import { ParticipantService } from '../../../../services/participant/participant.service';
import { TemplateRegistryService } from '../../../../services/template/template-registry.service';
import { ConnectionQualityIndicatorComponent } from '../../../connection-quality-indicator/connection-quality-indicator.component';
import { ParticipantAvatarComponent } from '../../../participant-avatar/participant-avatar.component';

/**
 * The **ParticipantPanelItemComponent** is hosted inside of the {@link ParticipantsPanelComponent}.
 * It displays participant information with enhanced UI/UX, including support for custom content
 * injection through structural directives.
 */
@Component({
	selector: 'ov-participant-panel-item',
	imports: [CommonModule, MatButtonModule, MatIconModule, MatListModule, MatSliderModule, MatTooltipModule, TranslatePipe, ParticipantAvatarComponent, ConnectionQualityIndicatorComponent],
	templateUrl: './participant-panel-item.component.html',
	styleUrls: ['./participant-panel-item.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush,
	standalone: true
})
export class ParticipantPanelItemComponent {
	readonly participantInput = input<ParticipantModel | undefined>(undefined, { alias: 'participant' });
	readonly muteButtonInput = input(true, { alias: 'muteButton' });
	private readonly libService = inject(OpenViduComponentsConfigService);
	private readonly participantService = inject(ParticipantService);
	private readonly volumeService = inject(ParticipantVolumeService);
	private readonly templateRegistry = inject(TemplateRegistryService);

	/**
	 * @ignore
	 */
	readonly showMuteButton = this.libService.participantItemMuteButtonSignal;
	/**
	 * @ignore
	 */
	readonly showAudioDetection = this.libService.displayAudioDetectionSignal;

	/**
	 * @ignore
	 */
	readonly externalParticipantBadge = contentChild(ParticipantPanelParticipantBadgeDirective);
	readonly externalParticipantPanelItemElements = contentChild(ParticipantPanelItemElementsDirective);
	readonly participantPanelItemElementsTemplate = computed(
		() =>
			this.externalParticipantPanelItemElements()?.template ??
			this.templateRegistry.participantPanelItemElements()
	);
	readonly participantBadgeTemplate = computed(() => this.externalParticipantBadge()?.template);
	readonly isLocalParticipant = computed(() => this.participantInput()?.isLocal || false);
	readonly participantDisplayName = computed(() => this.participantInput()?.name || '');
	readonly hasExternalElements = computed(() => !!this.participantPanelItemElementsTemplate());
	readonly isScreenSharing = computed(() => !!this.participantInput()?.isScreenShareEnabled);
	readonly isMicrophoneOff = computed(() => {
		const participant = this.participantInput();
		return !!participant && !participant.isMicrophoneEnabled;
	});
	readonly isCameraOff = computed(() => {
		const participant = this.participantInput();
		return !!participant && !participant.isCameraEnabled;
	});

	/** Local playback volume of this (remote) participant, see {@link ParticipantVolumeService}. */
	// The sliders work in whole percent: a fractional value would be snapped to the default step of 1
	// when a slider is created (e.g. the tile controls on every hover) before its step is applied.
	readonly maxPercent = ParticipantVolumeService.MAX * 100;
	readonly stepPercent = ParticipantVolumeService.STEP * 100;
	readonly volumePercent = computed(() => Math.round(this.volume() * 100));
	readonly volume = computed(() => {
		const identity = this.participantInput()?.identity;
		return identity ? (this.volumeService.volumes()[identity] ?? 1) : 1;
	});
	readonly volumeIcon = computed(() => {
		const v = this.volume();
		return v === 0 ? 'volume_off' : v < 1 ? 'volume_down' : 'volume_up';
	});

	formatPercent(percent: number): string {
		return `${Math.round(percent)}%`;
	}

	setVolumePercent(percent: number | string) {
		this.setVolume(Number(percent) / 100);
	}

	setVolume(value: number | string) {
		const identity = this._participant?.identity;
		if (identity) this.volumeService.setVolume(identity, Number(value));
	}

	resetVolume() {
		const identity = this._participant?.identity;
		if (identity) this.volumeService.resetVolume(identity);
	}

	get _participant(): ParticipantModel | undefined {
		return this.participantInput();
	}

	/**
	 * Toggles the mute state of a remote participant
	 */
	toggleMuteForcibly() {
		const participant = this._participant;
		if (participant && !participant.isLocal) {
			this.participantService.setRemoteMutedForcibly(participant.sid, !participant.isMutedForcibly);
		}
	}
}
