import { CommonModule } from '@angular/common';
import {
	ChangeDetectionStrategy,
	Component,
	computed,
	contentChild,
	effect,
	inject,
	OnDestroy,
	OnInit,
	output,
	signal,
	TemplateRef
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatSliderModule } from '@angular/material/slider';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SettingsPanelGeneralAdditionalElementsDirective } from '../../../directives/template/internals.directive';
import { CustomDevice } from '../../../models/device.model';
import { LangOption } from '../../../models/lang.model';
import { PanelSettingsOptions, PanelType } from '../../../models/panel.model';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { OpenViduComponentsConfigService } from '../../../services/config/directive-config.service';
import { HoldMusicService } from '../../../services/hold-music/hold-music.service';
import {
	AudioTrackProcessorService,
	NOISE_SUPPRESSION_STRENGTHS
} from '../../../services/track-processor/audio-track-processor.service';
import { PanelService } from '../../../services/panel/panel.service';
import { PlatformService } from '../../../services/platform/platform.service';
import { ViewportService } from '../../../services/viewport/viewport.service';
import { AudioDevicesComponent } from '../../settings/audio-devices/audio-devices.component';
import { LangSelectorComponent } from '../../settings/lang-selector/lang-selector.component';
import { ParticipantNameInputComponent } from '../../settings/participant-name-input/participant-name-input.component';
import {
	SpatialAudioOptionsComponent,
	SpatialAudioSelectorComponent
} from '../../settings/spatial-audio-selector/spatial-audio-selector.component';
import { ThemeSelectorComponent } from '../../settings/theme-selector/theme-selector.component';
import { VideoDevicesComponent } from '../../settings/video-devices/video-devices.component';

/** comeet: the microphone test stops recording on its own after this many seconds. */
const MIC_TEST_MAX_S = 60;

/**
 * @internal
 */
@Component({
	selector: 'ov-settings-panel',
	imports: [
		CommonModule,
		MatButtonModule,
		MatFormFieldModule,
		MatIconModule,
		MatListModule,
		MatSlideToggleModule,
		MatSliderModule,
		MatTooltipModule,
		TranslatePipe,
		ParticipantNameInputComponent,
		LangSelectorComponent,
		ThemeSelectorComponent,
		SpatialAudioSelectorComponent,
		SpatialAudioOptionsComponent,
		VideoDevicesComponent,
		AudioDevicesComponent
	],
	templateUrl: './settings-panel.component.html',
	styleUrls: ['../panel.component.scss', './settings-panel.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush,
	standalone: true
})
export class SettingsPanelComponent implements OnInit, OnDestroy {
	onVideoEnabledChanged = output<boolean>();
	onVideoDeviceChanged = output<CustomDevice>();
	onAudioEnabledChanged = output<boolean>();
	onAudioDeviceChanged = output<CustomDevice>();
	onLangChanged = output<LangOption>();

	private readonly panelService = inject(PanelService);
	private readonly platformService = inject(PlatformService);
	private readonly libService = inject(OpenViduComponentsConfigService);
	public readonly viewportService = inject(ViewportService);
	protected readonly holdMusic = inject(HoldMusicService);
	protected readonly noiseSuppression = inject(AudioTrackProcessorService);
	/** comeet: the noise suppression strength slider steps through these attenuation limits (dB). */
	protected readonly noiseStrengths = NOISE_SUPPRESSION_STRENGTHS;
	protected readonly noiseStrengthIndex = computed(() =>
		Math.max(0, (this.noiseStrengths as readonly number[]).indexOf(this.noiseSuppression.strength()))
	);
	/** null for the strongest step (no limit), which the template labels "Max". */
	protected readonly noiseStrengthLabel = computed(() => {
		const db = this.noiseSuppression.strength();
		return db >= 100 ? null : `${db} dB`;
	});

	protected setNoiseStrength(index: number | string): void {
		const db = this.noiseStrengths[Number(index)];
		if (db !== undefined) this.noiseSuppression.setStrength(db);
	}

	/** comeet: microphone test, records what the others hear until Stop (at most {@link MIC_TEST_MAX_S}) and plays it back. */
	protected readonly micTestRecording = signal(false);
	protected readonly micTestElapsed = signal(0);
	protected readonly micTestElapsedLabel = computed(() => {
		const s = this.micTestElapsed();
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	});
	protected readonly micTestUrl = signal<string | null>(null);
	/** Translation key of the last error. */
	protected readonly micTestError = signal<string | null>(null);
	private micTestRecorder?: MediaRecorder;
	private micTestTimer?: ReturnType<typeof setInterval>;

	protected startMicTest(): void {
		this.micTestError.set(null);
		const track = this.noiseSuppression.sentMicrophoneTrack();
		if (!track) {
			this.micTestError.set('PANEL.SETTINGS.MIC_TEST_NO_MIC');
			return;
		}
		if (typeof MediaRecorder === 'undefined') {
			this.micTestError.set('PANEL.SETTINGS.MIC_TEST_UNSUPPORTED');
			return;
		}
		this.clearMicTestUrl();
		const chunks: Blob[] = [];
		let recorder: MediaRecorder;
		try {
			recorder = new MediaRecorder(new MediaStream([track]));
		} catch {
			this.micTestError.set('PANEL.SETTINGS.MIC_TEST_UNSUPPORTED');
			return;
		}
		recorder.ondataavailable = ({ data }) => data.size && chunks.push(data);
		// Also fires when the track ends mid-recording (microphone switched off, noise suppression toggled).
		recorder.onstop = () => {
			this.endMicTestTimer();
			this.micTestRecording.set(false);
			if (this.micTestRecorder !== recorder) return; // component destroyed or a newer recording
			this.micTestRecorder = undefined;
			if (chunks.length) this.micTestUrl.set(URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType })));
		};
		this.micTestRecorder = recorder;
		recorder.start(250);
		this.micTestElapsed.set(0);
		this.micTestRecording.set(true);
		this.micTestTimer = setInterval(() => {
			this.micTestElapsed.update((s) => s + 1);
			if (this.micTestElapsed() >= MIC_TEST_MAX_S) this.stopMicTest();
		}, 1000);
	}

	protected stopMicTest(): void {
		if (this.micTestRecorder?.state === 'recording') this.micTestRecorder.stop();
	}

	private endMicTestTimer(): void {
		clearInterval(this.micTestTimer);
		this.micTestTimer = undefined;
	}

	private clearMicTestUrl(): void {
		const url = this.micTestUrl();
		if (url) URL.revokeObjectURL(url);
		this.micTestUrl.set(null);
	}

	/**
	 * @internal
	 * ContentChild for custom elements in general section
	 */
	readonly externalGeneralAdditionalElements = contentChild.required(SettingsPanelGeneralAdditionalElementsDirective);

	settingsOptions: typeof PanelSettingsOptions = PanelSettingsOptions;
	readonly isMobile = signal(false);

	readonly showCameraButton = this.libService.cameraButtonSignal;
	readonly showMicrophoneButton = this.libService.microphoneButtonSignal;
	readonly showThemeSelector = this.libService.showThemeSelectorSignal;
	readonly selectedOption = signal<PanelSettingsOptions>(PanelSettingsOptions.GENERAL);

	/**
	 * @internal
	 * Gets the template for additional elements in general section
	 */
	get generalAdditionalElementsTemplate(): TemplateRef<any> | undefined {
		return this.externalGeneralAdditionalElements()?.template;
	}

	readonly isCompactView = computed(() => {
		return this.viewportService.isMobileView() || this.viewportService.isTabletDown();
	});

	readonly isVerticalLayout = computed(() => {
		return this.viewportService.isMobileView();
	});

	readonly shouldHideMenuText = computed(() => {
		return !this.viewportService.isMobileView() && this.viewportService.isTablet();
	});

	private readonly panelTogglingEffect = effect(() => {
		const ev = this.panelService.panelOpened();
		if (ev.panelType === PanelType.SETTINGS && !!ev.subOptionType) {
			this.selectedOption.set(ev.subOptionType as PanelSettingsOptions);
		}
	});

	ngOnDestroy(): void {
		const recorder = this.micTestRecorder;
		this.micTestRecorder = undefined;
		if (recorder?.state === 'recording') recorder.stop();
		this.endMicTestTimer();
		this.clearMicTestUrl();
	}

	ngOnInit() {
		this.isMobile.set(this.platformService.isMobile());
	}

	close() {
		this.panelService.togglePanel(PanelType.SETTINGS);
	}
	onSelectionChanged(option: PanelSettingsOptions) {
		this.selectedOption.set(option);
	}

}
