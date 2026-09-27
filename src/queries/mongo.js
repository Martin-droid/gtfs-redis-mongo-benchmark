/**
 * The same six queries against MongoDB. Note query 6: Mongo can express the
 * origin->destination join server-side with $lookup, so the whole plan is one
 * round trip instead of N.
 */
export const mongoQueries = {
  async stopLookup(db, { stopId }) {
    return db.collection('stops').findOne({ _id: stopId });
  },

  async stopsNearby(db, { lat, lon, radiusM = 1000 }) {
    return db.collection('stops').find({
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [lon, lat] },
          $maxDistance: radiusM,
        },
      },
    }).toArray();
  },

  async departuresAtStop(db, { stopId, afterSec, limit = 10 }) {
    return db.collection('stop_times')
      .find({ stop_id: stopId, departure_sec: { $gte: afterSec } })
      .sort({ departure_sec: 1 })
      .limit(limit)
      .toArray();
  },

  async tripSchedule(db, { tripId }) {
    return db.collection('stop_times')
      .find({ trip_id: tripId })
      .sort({ stop_sequence: 1 })
      .toArray();
  },

  async routesServingStop(db, { stopId }) {
    return db.collection('stop_times').distinct('route_id', { stop_id: stopId });
  },

  /** Origin -> destination join, done server-side in one aggregation. */
  async directTrips(db, { fromStop, toStop, afterSec, limit = 5, scan = 40 }) {
    return db.collection('stop_times').aggregate([
      { $match: { stop_id: fromStop, departure_sec: { $gte: afterSec } } },
      { $sort: { departure_sec: 1 } },
      { $limit: scan },
      {
        $lookup: {
          from: 'stop_times',
          let: { trip: '$trip_id', seq: '$stop_sequence' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$trip_id', '$$trip'] },
                    { $eq: ['$stop_id', toStop] },
                    { $gt: ['$stop_sequence', '$$seq'] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: 'arrival',
        },
      },
      { $match: { 'arrival.0': { $exists: true } } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          tripId: '$trip_id',
          boardAt: '$departure_time',
          alightAt: { $arrayElemAt: ['$arrival.arrival_time', 0] },
        },
      },
    ]).toArray();
  },
};
