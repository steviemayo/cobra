# Room bookings on the panel

Status: built (read only). The panel shows what is on in the room's calendar and when the room is next free.

## What the panel shows

- **Room in use:** "In use", the meeting title, "Organised by …", start and end time, then **Next available at: 10:00 am**. Meetings that run straight into each other count as one, so the time is when the room is really free.
- **Room free:** "Available", then **Next meeting at: 1:00 pm** (or nothing when the day is clear).
- **Private or confidential meetings:** "Private meeting" and the times only. The title and organiser are removed in the cloud, before anything is sent to the gateway.
- **Where:** a slim strip under the top bar, and a card on the "Touch to begin" screen.
- **When it is not known** (calendar unreachable, or older than 20 minutes at the gateway) nothing is shown. A panel says nothing rather than something wrong.

## How it works

- A room uses the calendar named by its **calendar trigger** (Microsoft 365 or Google), with the connection under Settings > Calendars. No new setup. A room with no calendar trigger shows nothing.
- The calendar job (`/api/cron/calendar`, about every minute) reads each room's next 12 hours, at most every 4 minutes per room, and stores a copy in `RoomSchedule` (migration `20260927130000_room_schedule`).
- The heartbeat reply carries the copy to the gateway that runs the room, only if the gateway says it has the `schedule` feature. Copies older than 15 minutes are not sent.
- The gateway keeps them in memory and pushes a `schedule` message to each panel. The panel works out "on now" and "next" from its own clock, so it stays correct between updates.
- Read only: no calendar is ever written to. Microsoft 365 needs `Calendars.Read` (as for triggers). For Google, the room's calendar must be shared with "See all event details" or titles will be blank.

## Deploy order

Web first (it adds the migration and the heartbeat field), then gateways. An older gateway ignores the field and never asks for it.

## Not built

- Booking from the panel, and releasing no-shows (needs calendar write access).
- Turning bookings off for one room, or hiding titles for all meetings in a room.
- A day view on the panel.
- Showing bookings in the portal or the simulator.
