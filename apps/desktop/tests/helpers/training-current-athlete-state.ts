import { createInspectionAthleteState } from "./inspection-athlete-states.js";

const TRAINING_CONTEXT_JSON = `
{
  "performanceProgress": {
    "kind": "computed",
    "currentWindow": {
      "start": "1998-07-26",
      "end": "1998-08-22"
    },
    "previousWindow": {
      "start": "1998-06-28",
      "end": "1998-07-25"
    },
    "anchors": [
      {
        "durationSeconds": 5,
        "current": {
          "kind": "computed",
          "watts": 1120
        },
        "previous": {
          "kind": "computed",
          "watts": 1050
        },
        "change": {
          "kind": "computed",
          "percent": 6.7
        }
      },
      {
        "durationSeconds": 60,
        "current": {
          "kind": "computed",
          "watts": 620
        },
        "previous": {
          "kind": "computed",
          "watts": 600
        },
        "change": {
          "kind": "computed",
          "percent": 3.3
        }
      },
      {
        "durationSeconds": 300,
        "current": {
          "kind": "computed",
          "watts": 390
        },
        "previous": {
          "kind": "computed",
          "watts": 400
        },
        "change": {
          "kind": "computed",
          "percent": -2.5
        }
      },
      {
        "durationSeconds": 1200,
        "current": {
          "kind": "computed",
          "watts": 310
        },
        "previous": {
          "kind": "computed",
          "watts": 310
        },
        "change": {
          "kind": "computed",
          "percent": 0
        }
      },
      {
        "durationSeconds": 3600,
        "current": {
          "kind": "unavailable"
        },
        "previous": {
          "kind": "unavailable"
        },
        "change": {
          "kind": "unavailable"
        }
      }
    ],
    "rotation": "sprint",
    "heartRateContext": {
      "kind": "computed",
      "anchors": [
        {
          "durationSeconds": 60,
          "current": {
            "kind": "computed",
            "bpm": 181
          },
          "previous": {
            "kind": "computed",
            "bpm": 178
          },
          "change": {
            "kind": "computed",
            "percent": 1.7
          }
        },
        {
          "durationSeconds": 300,
          "current": {
            "kind": "computed",
            "bpm": 176
          },
          "previous": {
            "kind": "computed",
            "bpm": 175
          },
          "change": {
            "kind": "computed",
            "percent": 0.6
          }
        },
        {
          "durationSeconds": 1200,
          "current": {
            "kind": "computed",
            "bpm": 165
          },
          "previous": {
            "kind": "computed",
            "bpm": 166
          },
          "change": {
            "kind": "computed",
            "percent": -0.6
          }
        },
        {
          "durationSeconds": 3600,
          "current": {
            "kind": "computed",
            "bpm": 151
          },
          "previous": {
            "kind": "computed",
            "bpm": 152
          },
          "change": {
            "kind": "computed",
            "percent": -0.7
          }
        }
      ]
    },
    "sustainabilityContext": {
      "kind": "computed",
      "window": {
        "start": "1998-07-12",
        "end": "1998-08-22"
      },
      "coverageRatio": 0.83,
      "sourceContext": "mixed"
    },
    "freshness": "fresh",
    "asOf": "1998-08-22T08:00:00.000Z"
  },
  "recentRides": {
    "kind": "computed",
    "asOf": "1998-08-22T08:00:00.000Z",
    "windowDays": 28,
    "items": [
      {
        "id": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "subSport": "road",
        "startEpochSeconds": 903751200,
        "timezoneOffsetSeconds": 21600,
        "localDate": "1998-08-22",
        "elapsedSeconds": 7800,
        "movingSeconds": 7500,
        "distanceMeters": 61800
      },
      {
        "id": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "subSport": "indoor_cycling",
        "startEpochSeconds": 903618000,
        "timezoneOffsetSeconds": 21600,
        "localDate": "1998-08-20",
        "elapsedSeconds": 3300,
        "movingSeconds": 3000,
        "distanceMeters": 24100
      },
      {
        "id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "subSport": "road",
        "startEpochSeconds": 903528000,
        "timezoneOffsetSeconds": 21600,
        "localDate": "1998-08-19",
        "elapsedSeconds": 5100,
        "movingSeconds": 4800,
        "distanceMeters": 41000
      },
      {
        "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "subSport": "road",
        "startEpochSeconds": 903402000,
        "timezoneOffsetSeconds": 21600,
        "localDate": "1998-08-18",
        "elapsedSeconds": 5700,
        "movingSeconds": 5400,
        "distanceMeters": 48300
      },
      {
        "id": "7777777777777777777777777777777777777777777777777777777777777777",
        "subSport": "road",
        "startEpochSeconds": 903232800,
        "timezoneOffsetSeconds": 21600,
        "localDate": "1998-08-16",
        "elapsedSeconds": 7500,
        "movingSeconds": 7200,
        "distanceMeters": 60100
      },
      {
        "id": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "subSport": "road",
        "startEpochSeconds": 903009600,
        "timezoneOffsetSeconds": 21600,
        "localDate": "1998-08-13",
        "elapsedSeconds": 4800,
        "movingSeconds": 4500,
        "distanceMeters": 39200
      },
      {
        "id": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "subSport": "road",
        "startEpochSeconds": 902797200,
        "timezoneOffsetSeconds": 21600,
        "localDate": "1998-08-11",
        "elapsedSeconds": 5700,
        "movingSeconds": 5400,
        "distanceMeters": 47900
      }
    ]
  },
  "trainingHistory": {
    "kind": "computed",
    "asOf": "1998-08-22T08:00:00.000Z",
    "calendarTimeZone": "Asia/Almaty",
    "displayMode": "current",
    "coverage": {
      "kind": "contiguous",
      "start": "1998-05-01",
      "through": "1998-08-22",
      "committedAt": "1998-08-22T07:55:00.000Z"
    },
    "anchorWeek": {
      "id": "anchor",
      "window": {
        "start": "1998-08-17",
        "end": "1998-08-23"
      },
      "calendarState": "open",
      "coverage": {
        "kind": "complete"
      },
      "totals": {
        "rideCount": {
          "kind": "computed",
          "value": 4
        },
        "ridingSeconds": {
          "kind": "computed",
          "value": 20700
        },
        "distanceMeters": {
          "kind": "computed",
          "value": 175200
        },
        "load": {
          "kind": "computed",
          "value": 307
        }
      },
      "rides": {
        "count": {
          "kind": "exact",
          "value": 4
        },
        "items": [
          {
            "id": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "title": "Café ride",
            "subSport": "road",
            "startEpochSeconds": 903751200,
            "timezoneOffsetSeconds": 21600,
            "localDate": "1998-08-22",
            "ridingSeconds": 7500,
            "ridingTimeBasis": "moving",
            "elapsedSeconds": 7800,
            "distanceMeters": 61800,
            "load": 96,
            "averagePowerWatts": 181,
            "averageHeartRateBpm": 139,
            "perceivedExertion": 4,
            "energyKilojoules": 1358
          },
          {
            "id": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "title": null,
            "subSport": "indoor_cycling",
            "startEpochSeconds": 903618000,
            "timezoneOffsetSeconds": 21600,
            "localDate": "1998-08-20",
            "ridingSeconds": 3000,
            "ridingTimeBasis": "moving",
            "elapsedSeconds": 3300,
            "distanceMeters": 24100,
            "load": 31,
            "averagePowerWatts": 165,
            "averageHeartRateBpm": 128,
            "perceivedExertion": 3,
            "energyKilojoules": 495
          },
          {
            "id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "title": "Threshold 4×8",
            "subSport": "road",
            "startEpochSeconds": 903528000,
            "timezoneOffsetSeconds": 21600,
            "localDate": "1998-08-19",
            "ridingSeconds": 4800,
            "ridingTimeBasis": "moving",
            "elapsedSeconds": 5100,
            "distanceMeters": 41000,
            "load": 102,
            "averagePowerWatts": 236,
            "averageHeartRateBpm": 158,
            "perceivedExertion": 8,
            "energyKilojoules": 1133
          },
          {
            "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "title": "Endurance",
            "subSport": "road",
            "startEpochSeconds": 903402000,
            "timezoneOffsetSeconds": 21600,
            "localDate": "1998-08-18",
            "ridingSeconds": 5400,
            "ridingTimeBasis": "moving",
            "elapsedSeconds": 5700,
            "distanceMeters": 48300,
            "load": 78,
            "averagePowerWatts": 198,
            "averageHeartRateBpm": 142,
            "perceivedExertion": 5,
            "energyKilojoules": 1070
          }
        ],
        "truncated": false
      },
      "trend": {
        "kind": "computed",
        "buckets": [
          {
            "window": {
              "start": "1998-07-06",
              "end": "1998-07-12"
            },
            "rideCount": 3,
            "ridingSeconds": 12600
          },
          {
            "window": {
              "start": "1998-07-13",
              "end": "1998-07-19"
            },
            "rideCount": 4,
            "ridingSeconds": 16200
          },
          {
            "window": {
              "start": "1998-07-20",
              "end": "1998-07-26"
            },
            "rideCount": 2,
            "ridingSeconds": 9000
          },
          {
            "window": {
              "start": "1998-07-27",
              "end": "1998-08-02"
            },
            "rideCount": 4,
            "ridingSeconds": 15300
          },
          {
            "window": {
              "start": "1998-08-03",
              "end": "1998-08-09"
            },
            "rideCount": 3,
            "ridingSeconds": 13500
          },
          {
            "window": {
              "start": "1998-08-10",
              "end": "1998-08-16"
            },
            "rideCount": 3,
            "ridingSeconds": 17100
          }
        ]
      },
      "callout": {
        "kind": "longest-ride-28d",
        "rideId": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "durationSeconds": 7500,
        "window": {
          "start": "1998-07-26",
          "end": "1998-08-22"
        },
        "comparisonRideCount": 14
      }
    },
    "previousWeek": {
      "id": "previous",
      "window": {
        "start": "1998-08-10",
        "end": "1998-08-16"
      },
      "calendarState": "closed",
      "coverage": {
        "kind": "complete"
      },
      "totals": {
        "rideCount": {
          "kind": "computed",
          "value": 3
        },
        "ridingSeconds": {
          "kind": "computed",
          "value": 17100
        },
        "distanceMeters": {
          "kind": "computed",
          "value": 147200
        },
        "load": {
          "kind": "computed",
          "value": 262
        }
      },
      "rides": {
        "count": {
          "kind": "exact",
          "value": 3
        },
        "items": [
          {
            "id": "7777777777777777777777777777777777777777777777777777777777777777",
            "title": "Long ride",
            "subSport": "road",
            "startEpochSeconds": 903232800,
            "timezoneOffsetSeconds": 21600,
            "localDate": "1998-08-16",
            "ridingSeconds": 7200,
            "ridingTimeBasis": "moving",
            "elapsedSeconds": 7500,
            "distanceMeters": 60100,
            "load": 98,
            "averagePowerWatts": 186,
            "averageHeartRateBpm": 143,
            "perceivedExertion": 5,
            "energyKilojoules": 1339
          },
          {
            "id": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "title": "Sweet spot 3×12",
            "subSport": "road",
            "startEpochSeconds": 903009600,
            "timezoneOffsetSeconds": 21600,
            "localDate": "1998-08-13",
            "ridingSeconds": 4500,
            "ridingTimeBasis": "moving",
            "elapsedSeconds": 4800,
            "distanceMeters": 39200,
            "load": 88,
            "averagePowerWatts": 228,
            "averageHeartRateBpm": 154,
            "perceivedExertion": 7,
            "energyKilojoules": 1026
          },
          {
            "id": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "title": "Endurance",
            "subSport": "road",
            "startEpochSeconds": 902797200,
            "timezoneOffsetSeconds": 21600,
            "localDate": "1998-08-11",
            "ridingSeconds": 5400,
            "ridingTimeBasis": "moving",
            "elapsedSeconds": 5700,
            "distanceMeters": 47900,
            "load": 76,
            "averagePowerWatts": 195,
            "averageHeartRateBpm": 141,
            "perceivedExertion": 5,
            "energyKilojoules": 1053
          }
        ],
        "truncated": false
      },
      "trend": {
        "kind": "computed",
        "buckets": [
          {
            "window": {
              "start": "1998-06-29",
              "end": "1998-07-05"
            },
            "rideCount": 2,
            "ridingSeconds": 9900
          },
          {
            "window": {
              "start": "1998-07-06",
              "end": "1998-07-12"
            },
            "rideCount": 3,
            "ridingSeconds": 12600
          },
          {
            "window": {
              "start": "1998-07-13",
              "end": "1998-07-19"
            },
            "rideCount": 4,
            "ridingSeconds": 16200
          },
          {
            "window": {
              "start": "1998-07-20",
              "end": "1998-07-26"
            },
            "rideCount": 2,
            "ridingSeconds": 9000
          },
          {
            "window": {
              "start": "1998-07-27",
              "end": "1998-08-02"
            },
            "rideCount": 4,
            "ridingSeconds": 15300
          },
          {
            "window": {
              "start": "1998-08-03",
              "end": "1998-08-09"
            },
            "rideCount": 3,
            "ridingSeconds": 13500
          }
        ]
      },
      "callout": null
    }
  },
  "anchorZones": {
    "kind": "unknown",
    "reason": "missing-anchor"
  },
  "cyclingLoad": {
    "kind": "computed",
    "asOf": "1998-08-22T08:00:00.000Z",
    "source": "intervals.icu",
    "windowDays": 7,
    "value": 307,
    "activityCount": 4,
    "missingLoadCount": 0
  },
  "plan": {
    "kind": "computed",
    "asOf": "1998-08-22T08:00:00.000Z",
    "items": []
  },
  "adherence": {
    "kind": "unknown",
    "reason": "insufficient-data"
  },
  "wellnessTrend": {
    "kind": "unknown",
    "reason": "no-wellness"
  }
}
`;

export const TRAINING_CURRENT_ATHLETE_STATE = createInspectionAthleteState(
  JSON.parse(TRAINING_CONTEXT_JSON) as unknown,
);
