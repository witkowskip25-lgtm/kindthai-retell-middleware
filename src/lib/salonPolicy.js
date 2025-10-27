/**
 * Salon policy: weekly therapist roster + capacity (rooms).
 * Weekday numbers follow Luxon: 1=Mon ... 7=Sun
 */
const ROSTER = {
  1: ["Rose", "Lilly"], // Monday
  2: ["Rose", "Lilly"], // Tuesday
  3: ["Rose", "Kat"],   // Wednesday
  4: ["Lilly", "Rose"], // Thursday
  5: ["Lilly", "Nina"], // Friday
  6: ["Nina", "Kat"],   // Saturday
  7: ["Lilly", "Nina"]  // Sunday
};

// Salon has only 2 rooms total.
const MAX_ROOMS = 2;

module.exports = { ROSTER, MAX_ROOMS };
