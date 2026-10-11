import type { CreateTripInput } from "@along-the-way/contracts/private-trips";

/** Outside the default 09:00–19:00 planning window, with all local dates inside the trip. */
export function tripFlights(startDate = "2026-10-21", endDate = "2026-10-27", timeZone = "Asia/Tokyo"): CreateTripInput["flights"] {
  return {
    outbound: {
      serviceNumber: "FIXTURE-OUT", carrier: null,
      departureAirport: { name: "Fixture home airport", timeZone },
      arrivalAirport: { name: "Fixture destination airport", timeZone },
      departureLocalDateTime: `${startDate}T05:00`, arrivalLocalDateTime: `${startDate}T06:00`,
    },
    return: {
      serviceNumber: "FIXTURE-RETURN", carrier: null,
      departureAirport: { name: "Fixture destination airport", timeZone },
      arrivalAirport: { name: "Fixture home airport", timeZone },
      departureLocalDateTime: `${endDate}T22:00`, arrivalLocalDateTime: `${endDate}T23:00`,
    },
  };
}
