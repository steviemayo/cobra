# Pricing tier example (snapshot, 2026-10-07)

Status: a worked example to refer back to, **not decided and not built**. The decided and built pricing is in `docs/decisions.md` (TM-1..13, and the later billing sections). Nothing here changes Stripe or the plans.

## The idea

- Two plans: **Essentials** (monitoring) and **Premium** (monitoring plus the extras). Per room, per month, AUD, excluding GST
- Volume bands on the organisation's **total** rooms: 1 to 25, 26 to 50, 51 and over
- **Graduated** pricing: each band's rooms are charged at that band's rate. This is what stops 51 rooms costing less than 50
- Annual price = 10 x the monthly total (two months free, about 16.7% off)

Assumption: the third band is "51 and over". The original request listed ">50" twice, so if a 100-room band was meant, redo the table below.

## Per-room monthly rates

| Rooms in band | Essentials | Premium |
|---|---|---|
| 1 to 25 | $3.00 | $15.00 |
| 26 to 50 | $2.50 | $12.00 |
| 51 and over | $2.00 | $10.00 |

Premium is 5x Essentials in every band. The requested starting points were $3 for Essentials and $10 or $15 for Premium. This example uses $15 at the entry band and $10 at the top band, which covers both.

## Totals

| Rooms | Essentials /mo | Essentials /yr | Premium /mo | Premium /yr |
|---|---|---|---|---|
| 10 | $30.00 | $300 | $150 | $1,500 |
| 25 | $75.00 | $750 | $375 | $3,750 |
| 26 | $77.50 | $775 | $387 | $3,870 |
| 50 | $137.50 | $1,375 | $675 | $6,750 |
| 51 | $139.50 | $1,395 | $685 | $6,850 |
| 100 | $237.50 | $2,375 | $1,175 | $11,750 |

How they are built (Essentials): 25 x 3.00 = 75. 50 rooms = 75 + 25 x 2.50 = 137.50. 100 rooms = 137.50 + 50 x 2.00 = 237.50. Premium the same with 15 / 12 / 10.

Effective per-room price at 100 rooms: Essentials $2.375 a month, Premium $11.75 a month ($1.98 and $9.79 on an annual plan).

## Cheat checks (why it is built this way)

- **Band edges.** 26 rooms costs $2.50 more than 25 (Essentials) and 51 costs $2.00 more than 50, because every added room adds at least the lowest band rate. With "volume" pricing (one rate for all rooms) 26 or 51 rooms could cost less than 25 or 50, so do not use it
- **Premium vs Essentials.** Premium is above Essentials at every room count
- **Mixed tiers.** Count the bands on the organisation's total rooms, not per tier. Counted per tier, a customer could split rooms across tiers and reset the discounts. Fill band slots with Premium rooms first, so upgrading any room always adds cost
- **Annual vs monthly.** Compare within the same billing interval. Annual 51 rooms ($1,395) is cheaper than monthly 50 rooms ($1,650 a year). That is the commitment discount and cannot be removed while annual is discounted at all
- **Churning rooms.** Deleting and re-adding rooms part-way through a cycle could dodge charges. Bill on the peak room count in the period, or give no credit for removals until renewal

## Notes to remember

- **Stripe.** Graduated pricing is native: `billing_scheme: tiered` with `tiers_mode: graduated`, one price per tier and interval
- **Existing rules to reconcile.** Basic is capped at 500 rooms per organisation (staff can raise it), the trial gives 5 rooms with control for 30 days, and a lapsed Pro falls back to Basic (see TM-1..13). Above 100 rooms, consider "contact us" pricing rather than more bands
- **Margin check not done.** Premium at 50 or more rooms works out at about $13.50 a room at 50 and $11.75 at 100. Check it against costs (Supabase, Vercel, Stripe fees) before using any of these numbers
- **Names.** The built plans are called Basic and Pro. "Essentials" and "Premium" are working names from this discussion
