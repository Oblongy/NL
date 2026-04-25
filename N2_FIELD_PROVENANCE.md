# `<n2>` Field Provenance

This document classifies the `getonecarengine` / practice `<n2>` payload fields by evidence level.

## Sources

- FFDec ActionScript export:
  - [frame_12/DoAction.as](</C:/Users/Dilldo/Music/Library/1320L/tmp_ffdec_3_export/scripts/frame_12/DoAction.as:8481>)
  - [DefineSprite_4103_racePlay/frame_20/DoAction.as](</C:/Users/Dilldo/Music/Library/1320L/tmp_ffdec_3_export/scripts/DefineSprite_4103_racePlay/frame_20/DoAction.as:60>)
  - [RaceControls.as](</C:/Users/Dilldo/Music/Library/1320L/tmp_ffdec_3_export/scripts/__Packages/classes/RaceControls.as:32>)
  - [RaceSound.as](</C:/Users/Dilldo/Music/Library/1320L/tmp_ffdec_3_export/scripts/__Packages/classes/RaceSound.as:31>)
- Backend generator:
  - [src/game-actions.js](</C:/Users/Dilldo/Music/Library/1320L/backend/src/game-actions.js:4950>)
  - [src/engine-physics.js](</C:/Users/Dilldo/Music/Library/1320L/backend/src/engine-physics.js:35>)

## Confirmed By FFDec Client Use

These fields are directly read by the original Flash client callback in `getOneCarEngineCB(d)`.

- `es`: copied to `classes.GlobalData.engineSound`
- `sl`: copied to `classes.GlobalData.shiftLightGaugeRPM`
- `sg`: determines `classes.GlobalData.hasShiftLightGauge`
- `rc`: copied to `classes.GlobalData.raceControlsID`
- `tmp`: copied to `classes.GlobalData.temp`

Downstream usage confirmed in FFDec:

- `es` selects engine sound bank in `RaceSound`
- `sl` drives shift-light / tach redline behavior in `RaceControls`
- `rc` selects the control cluster / gauge skin
- `tmp` is passed into `takeControlsID(...)` when the control cluster is initialized

## Backed By Local RaceManager / Backend Logic

These fields are computed by this backend and have a clear internal source, but were not directly confirmed by the FFDec callback above.

- `r`: weight-derived field (`showroom weight + 18`)
- `a`: power peak rpm
- `n`: torque peak rpm
- `o`: rev limiter rpm
- `f`, `g`, `h`, `i`, `j`: gear ratios
- `l`: final drive
- `x`, `y`, `z`: horsepower-derived physics params
- `aa`: cylinder count inferred from engine string
- `ab`: valve count (`aa * 4`)

These come from `buildN2Fields(...)` and the redline / gearbox helpers in the backend. They are consistent with the current local race simulation path, but not proven to match the original production server byte-for-byte.

## Placeholder Or Inferred

These fields are currently emitted by the backend with constants or simple defaults and are not confirmed by the FFDec callback we inspected.

- `v`
- `s`
- `b`
- `p`
- `c`
- `e`
- `d`
- `k`
- `q`
- `m`
- `t`
- `u`
- `w`
- `ac`
- `ad`
- `ae`
- `af`
- `ag`
- `ah`
- `ai`
- `aj`
- `ak`
- `al`
- `am`
- `an`
- `ao`
- `ap`
- `aq`
- `ar`
- `as`
- `at`
- `au`
- `av`
- `aw`
- `ax`

Notes:

- `p` currently happens to match the Integra displacement when set to `1.8`, but it is not dynamically derived in the generator.
- `ae` through `aw` currently behave like legacy health / status defaults in our output, but that interpretation is not confirmed from the FFDec callback alone.
- `d` appears to represent induction or drive mode in existing payloads, but that is inferred from observed values rather than proven here.

## Practical Rule

When changing engine naming or showroom specs:

- Treat `sl` as the highest-risk compatibility field because FFDec proves the client uses it.
- Treat `es`, `sg`, `rc`, and `tmp` as protocol fields that must remain coherent.
- Treat the remaining fields as compatibility-sensitive, but only partially proven unless backed by capture data or another authoritative source.

## Current B18C1 Impact

For catalog car `1`, changing the showroom engine string to `B18C1 1.8L I4 VTEC` is compatible with the confirmed client contract because:

- `sl` still resolves to `7600`
- the client still receives valid `es`, `sg`, `rc`, and `tmp` attributes
- the rest of the payload remains structurally unchanged
