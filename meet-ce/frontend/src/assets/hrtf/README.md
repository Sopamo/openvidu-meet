# HRTF data

`thk-ku100-nf150-circ360.f32`: head-related impulse responses of a Neumann KU100 dummy head for a source 1.5 m
away on the horizontal plane, every 1° of azimuth, measured by the Audio Group of TH Köln (Technische Hochschule
Köln, Johannes Arend, Christoph Pörschmann, Benjamin Bernschütz).

- Source: `HRIR_CIRC360_NF150.sofa`, https://sofacoustics.org/data/database/thk/ (http://audiogroup.web.th-koeln.de)
- License: Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0); this converted file is shared under the
  same license.
- Changes: converted from SOFA to raw little-endian float32, laid out as `[azimuth 0..359][ear left, right][128
  taps]` at 48 kHz, azimuth counter-clockwise (90° = left), and scaled so that the mean energy of both ears for a
  source straight ahead is 1.

Used by `SpatialAudioService` (spatial audio mode "TH Köln KU100").
