export const SYNTHETIC_GEO_ALGORITHM = "spherical-small-circle-distance-parameterized" as const;
export const SYNTHETIC_GEO_EARTH_RADIUS_M = 6371008.8 as const;
export const SYNTHETIC_GEO_CENTER = Object.freeze({ lat: -46, lon: -127 });
export const SYNTHETIC_GEO_BOX = Object.freeze({
  minLat: -48,
  maxLat: -44,
  minLon: -130,
  maxLon: -124,
});
export const SYNTHETIC_GEO_LAPS = 3 as const;
export const SYNTHETIC_GEO_QUANTIZATION = "round(degrees*2^31/180)" as const;
export const SYNTHETIC_GEO_MAX_CUMULATIVE_DIVERGENCE_RATIO = 0.01 as const;
export const FIT_DATE_TIME_FLOOR_RAW = 0x10000000 as const;
export const FIT_DATE_TIME_FLOOR_ISO = "1998-07-03T21:24:16.000Z" as const;
export const SYNTHETIC_FILE_ID_SERIAL_MIN = 90401 as const;
export const SYNTHETIC_FILE_ID_SERIAL_MAX = 90408 as const;
export const LOCAL_ENCODER_PACKAGE = "@garmin/fitsdk" as const;
export const LOCAL_ENCODER_VERSION = "21.208.0" as const;
