# Store All Valet

A valet storage service where customers book empty bins for delivery, fill them at home, and the company collects, warehouses, and returns bins on demand. Bins are the unit of truth — every lifecycle step is tracked per bin, not per booking.

## People & access

**Customer**:
A person who books storage and tracks their bins by phone or booking reference. Customers never sign in.
_Avoid_: User, tenant, account

**Staff**:
An internal operator who signs in to run the service. There are three roles: admin, warehouse, and driver.
_Avoid_: Employee, operator, user

**Admin**:
Staff who manage bookings, assign bins, cancel bookings, view stats and reports, reset demo data, provision other staff accounts, and deactivate or reactivate staff access.
_Avoid_: Manager, back-office

**Warehouse**:
Staff who put bins away in the rack, scan bins out for delivery, and intake returned bins.
_Avoid_: Storekeeper, picker

**Driver**:
Staff who execute scheduled jobs on the jobs board — delivering empty bins, collecting filled bins, and returning stored bins to the customer.
_Avoid_: Courier, delivery person

**Surface**:
The UI a staff role sees after sign-in (`/admin`, `/warehouse`, or `/driver`). Each role only accesses its own surface.
_Avoid_: Portal, dashboard, console

## Physical inventory

**Bin**:
A physical storage container tracked by barcode. Bins carry the authoritative state of the system — status, customer, booking, warehouse location, and contents photo all live on the bin.
_Avoid_: Unit, container, asset

**SKU**:
The bin size or type. One of `bin`, `wardrobe`, or `odd`. A booking specifies how many of each SKU the customer wants.
_Avoid_: Product, item type, size

**Location**:
A rack slot in the warehouse, identified by barcode (e.g. `A-01-1-01`). A location is either free or occupied by exactly one stored bin.
_Avoid_: Rack, slot, bay, cell

**Inventory**:
The pool of bins not currently bound to an active booking. A bin re-enters inventory when it is unassigned or closed out.
_Avoid_: Stock, available units

## Bookings & service area

**Booking**:
A customer's request for a specific mix of bin SKUs to be delivered on a date and time window. A booking has no status of its own — its progress is derived from its bins.
_Avoid_: Order, reservation, contract

**Derived summary**:
The display string that describes a booking by aggregating its bins' statuses (e.g. "5 bins — 4 Stored, 1 Returned to customer"). Computed on the fly, never stored as authoritative state.
_Avoid_: Booking status, order status

**Service area**:
A geographic area where the valet service is offered. Bookings outside the service area cannot proceed; the customer joins a waitlist instead.
_Avoid_: Coverage zone, delivery zone, region

**Lead**:
A person outside the service area who left their email to be notified when coverage expands.
_Avoid_: Waitlist entry, prospect, signup

**Delivery window**:
A time-of-day slot for empty-bin delivery. Morning (8am–12pm) or Afternoon (12–5pm). Each window has a daily capacity cap so routes can be batched.
_Avoid_: Time slot, appointment, shift

## Bin lifecycle

**Bin status**:
The current stage of a single bin in its lifecycle. The seven active statuses are: Assigned → Out for filling → In transit (inbound) → Stored → Retrieval requested → In transit (outbound) → Returned to customer. A bin may also be unassigned (no status) or Returned / closed.
_Avoid_: State, phase, stage

**Lifecycle**:
One complete journey of a bin from first assignment to a booking through to close or re-store. A closed bin may start a new lifecycle when assigned to a different booking; its movement history spans all lifecycles.
_Avoid_: Cycle, tenure, rental period

**Assign bins**:
The act of binding specific physical bins from inventory to a booking. Assigned bins are reserved for that customer and appear on the deliver-empty job.
_Avoid_: Allocate, link, attach

**Put-away**:
Warehouse operation that stores an inbound bin at a free location, moving it to Stored.
_Avoid_: Rack, shelve, store (as a verb — use "put-away" or "store a bin" in prose)

**Scan-out**:
Warehouse operation that pulls a stored bin off the rack for outbound delivery, freeing its location.
_Avoid_: Pick, pull-out, retrieve (warehouse sense)

**Contents photo**:
A photo the customer attaches to a filled bin before collection. Attaching a photo is the customer's signal that the bin is ready to be collected.
_Avoid_: Inventory photo, proof photo, upload

**Retrieval request**:
A customer action asking for a stored bin to be delivered back to their door on a chosen date.
_Avoid_: Return request, delivery request, get-back

**Re-store**:
A customer action to send a bin that is back with them (Returned to customer) into storage again. The bin skips Out for filling because it is already filled.
_Avoid_: Re-rack, store again, re-book

**Close**:
End a bin's current lifecycle. The bin is released back to inventory — booking, customer, and photo cleared — and may be assigned to a new booking. The movement log preserves the full chain of custody.
_Avoid_: Complete, finish, terminate

**Cancellation**:
An admin action that deletes a booking and releases all its bins back to inventory. Unlike a normal status change, cancellation is an explicit escape hatch that removes the booking entirely.
_Avoid_: Void, refund, abort

**Cancel unassigned booking**:
An admin action that deletes a booking before any physical bins have been assigned. Removes the booking and its Deliver empty job without touching inventory.
_Avoid_: Void booking, delete order

**Cancel retrieval**:
A customer or admin action that reverses a retrieval request. Bins in Retrieval requested return to Stored; the Scheduled Deliver back job is updated or removed.
_Avoid_: Undo return, cancel delivery back

**No-show**:
An admin action for a bin in Out for filling that the customer never filled. The bin is released to unassigned inventory (same end state as Close, but from an earlier lifecycle stage) and any Scheduled Collect full job is reconciled.
_Avoid_: Abandon, customer no-fill, release bin

## Jobs & field work

**Job**:
A scheduled task for a driver, tied to a booking. Jobs have a type, a scheduled date (and optionally a window), a list of bin IDs, and a status of Scheduled or Done.
_Avoid_: Task, work order, route stop

**Deliver empty**:
A job to deliver assigned empty bins to the customer's address. When marked Done, the bins become Out for filling.
_Avoid_: Drop-off, initial delivery, empty run

**Collect full**:
A job to pick up filled bins from the customer and bring them to the warehouse. When marked Done, the bins become In transit (inbound).
_Avoid_: Pickup, collection run, inbound collection

**Deliver back**:
A job to return stored bins to the customer after a retrieval request. When marked Done, the bins become Returned to customer.
_Avoid_: Return delivery, outbound delivery, redelivery

**Jobs board**:
The driver and admin view of all scheduled and completed jobs.
_Avoid_: Dispatch board, task list, queue

**Scheduled Job merge**:
A Booking has at most one Scheduled Collect full and one Scheduled Deliver back at a time. New requests append bins to the existing Job or reschedule its date rather than creating duplicates.
_Avoid_: Per-bin job, duplicate job, multiple scheduled pickups

## Audit & invariants

**Movement**:
An immutable record of a bin status change — who acted, from which status to which, at which location, and optionally which job triggered it. Together, a bin's movements form its chain of custody.
_Avoid_: Event, log entry, audit row, history item

**Chain of custody**:
The complete, ordered sequence of movements for a bin across all lifecycles. Nothing is deleted; even cancelled bookings and closed bins leave a trace.
_Avoid_: Audit trail, history, timeline

**Legal transition**:
A bin status change that follows the allowed path in the lifecycle table. Any move not in the table is rejected — there is no silent workaround.
_Avoid_: Valid state change, permitted move

## Money & pilot economics

These terms only appear in the business case (`docs/business-case/`), not in the app. All figures are BBD and VAT-inclusive unless the term says otherwise.

**Stop**:
One visit by the driver to a customer address — an empty drop, a filled collection, or a deliver back. The unit the field cost model is priced in.
_Avoid_: Trip, visit, run, drop

**Touch**:
One warehouse handling of a single bin — a put-away or a scan-out. Priced separately from a stop because it is per bin, not per address.
_Avoid_: Handle, move, pick

**Cash cost**:
Money that leaves the bank because the stop or touch happened — fuel and vehicle wear. Excludes salary, which is already paid whether or not the stop happens.
_Avoid_: Variable cost, marginal cost, out-of-pocket

**Loaded cost**:
Cash cost plus an allocated share of the FTE's salary and vehicle fixed cost, spread over expected stops. What a stop "really" costs if you charge time to it.
_Avoid_: Fully burdened, true cost, all-in cost

**Gap**:
Revenue minus loaded cost on a single event. A negative gap is expected and deliberate in this pilot — storage rent, not trip fees, is meant to cover the FTE.
_Avoid_: Loss, deficit, shortfall

**Contribution**:
Net revenue after VAT, minus fixed cost, processing, ramp cash and surge. What is left to repay the $72k.
_Avoid_: Profit, margin, EBITDA

**Ramp cash**:
The $40 of cash cost spent to onboard one new account (empty drop plus filled collection). Charged in the month the account starts.
_Avoid_: CAC, acquisition cost, setup cost

**FTE**:
One full-time field person — driver and warehouse in the same body, at $3,200/month loaded. The pilot funds exactly one.
_Avoid_: Headcount, staff member, employee (in cost prose)

**Surge line**:
The $250/month standing allowance for the named backup person to cover absence or peaks. Not a second FTE.
_Avoid_: Overtime, contingency, cover

**Borrow**:
An outbound where the customer takes bins home for the 7-day pack window and later re-stores them free. Costs two stops for one $50 fee.
_Avoid_: Temporary retrieval, loan, take-out

**Close-out**:
An outbound where the customer keeps the contents and the bins come back to inventory. Ends the lifecycle; one stop for one $50 fee.
_Avoid_: Move-out, termination, final retrieval

**Position**:
One rack slot bought in the facility fit-out. Distinct from a bin: positions are capacity, bins are inventory.
_Avoid_: Slot count, capacity unit, space

**Occupancy**:
Occupied positions ÷ installed positions. The month-6 metric that decides scale.
_Avoid_: Utilisation, fill rate, take-up

**Gate**:
A named go/no-go checkpoint. Gate 0 is prepaid demand before any spend; Gate 1 is legal, insurance and lease before the fit-out.
_Avoid_: Milestone, phase, stage-gate

**Green / Amber / Red**:
The verdict of a gate or metric against its stated thresholds. **Green** means proceed as planned; **Amber** means proceed only with a written fix or reprice; **Red** means stop or extend. "A green month 6" means every must-hit metric sat in its green band at month 6 — nothing to do with cash colour.
_Avoid_: Pass/fail, on track, healthy

**Must-hit metric**:
A metric whose red band stops the pilot. Distinct from a **watch metric**, whose red band only forces a reprice or a written fix.
_Avoid_: KPI, target, threshold

**Template figure**:
A number carried from an industry template rather than a Barbados quote or observed cost. Tagged `Template` in the document and must be replaced before the scale paper.
_Avoid_: Estimate, assumption, placeholder

## Offer & demand

**Tote**:
The one bin SKU sold in the pilot — hard-sided, 2.3 cu ft, 24″ × 19.5″ × 12.5″, max 25 kg. In the pilot "tote" and "bin" are the same object; prefer **bin** in the app, **tote** only when contrasting with a Store All unit.
_Avoid_: Box, crate, container

**Unit**:
A conventional self-storage space rented from Store All (5×6, 5×8). The thing valet competes with — never a synonym for a bin.
_Avoid_: Locker, space, storage room

**Script**:
The sales rule for steering an enquiry: 1–6 bins → valet, 7–8 → show the unit too, 9+ or furniture → unit.
_Avoid_: Playbook, sales guide, cut-off

**Account**:
The commercial relationship with one household — the billing and demand unit (5.5 bins each). A **Customer** is the person; an account is what gets counted at Gate 0 and billed monthly.
_Avoid_: Household (in counts), subscriber, client

**Confirmed account**:
An account that has versioned T&Cs, a prepaid first month on the reserved bin count, a card on file in Plug'n Pay, and an empty-drop date within 45 days. Nothing else counts as demand.
_Avoid_: Signup, lead, prepaid customer, booking

**Reserved bin**:
A bin count a confirmed account has prepaid for, before any physical bin exists. Distinct from an **occupied bin**, which is physically on the rack and billing $30.
_Avoid_: Booked bin, committed bin, sold bin

**Occupied bin**:
A bin physically stored in the facility and therefore charging $30/month. Month 1 assumes occupied ≈ 70% of reserved.
_Avoid_: Stored bin (in financial prose), active bin, filled bin

**Outbound order**:
One customer request to bring bins out of the facility, priced at $50 regardless of bin count. Realises as a borrow or a close-out. Not the same as a **Booking**.
_Avoid_: Order (unqualified), retrieval job, trip

**Pack window**:
The 7 free days a customer holds bins at home — after an empty drop, or after a borrow. Then $10/bin/day until inbound is booked. Waived if we cannot offer a slot.
_Avoid_: Grace period, free period, borrow window

**Hold fee**:
The $10/bin/day charged past the pack window. Upside; not in the base P&L.
_Avoid_: Late fee, penalty, overdue charge

**ARPU**:
Average revenue per account per month. **Gross ARPU** ($171) is VAT-inclusive; **net ARPU** (~$146) is gross ÷ 1.175.
_Avoid_: Average spend, revenue per customer

**LTV**:
Contribution per account per month × expected tenure (33 months for households), before central overhead. Ross tenure is excluded from the headline figure.
_Avoid_: Lifetime value (unqualified — always say whether it is revenue or contribution)

**CAC**:
Cash to win one confirmed account — campaign spend ÷ accounts, plus $40 ramp cash. ~$140 in the pilot.
_Avoid_: Acquisition spend, cost per signup

**Churn**:
Share of accounts leaving per month. 3% for households (~33 months), higher for Ross.
_Avoid_: Attrition, drop-off, cancellation rate

**Ross stress**:
The Ross University student segment — modelled as a stress case (25% of accounts, 8 bins, ~11 months, May/June close-out spike), deliberately kept out of the headline LTV.
_Avoid_: Student segment, secondary market

## Facility & capacity

**Facility**:
The leased warehouse the bins live in, at $1,500/month. Where put-away, storage and scan-out happen.
_Avoid_: Warehouse (in cost prose), depot, store

**Bay**:
The physical leased space being priced — used interchangeably with facility when talking about rent and fit-out size ("a 250-bin bay").
_Avoid_: Unit, lot, premises

**Fit-out**:
The one-off build of the facility — racking, bins, barcodes, CCTV, consumables. $43,300 base, $49,795 with contingency.
_Avoid_: Setup, install, capex (unqualified)

**Steady state**:
The modelled working shape of the operation — 85% of 500 positions, ~425 bins, ~77 accounts. A shape to judge the model by, not a year-1 forecast.
_Avoid_: Full capacity, run rate, mature state

**Break-even**:
The occupied-bin count where contribution covers fixed cost — ~260 bins (52%) on $6,650, ~270 (54%) including surge. The pilot uses 54%.
_Avoid_: Profitability point, cover

**Peak cash**:
The deepest point of cumulative negative cash before contribution turns it around — ~$51,400 around month 3 in the base case, ~$57,000 on slow ramp.
_Avoid_: Burn, drawdown, funding need

**Cash exposure**:
The hard ceiling on cumulative cash out: $72,000. Escalate before $65,000 is committed.
_Avoid_: Budget, spend cap, investment

**Payback**:
Months from launch until cumulative cash returns to zero — ~month 17 base case. The scale test requires it inside 24 months.
_Avoid_: ROI, return, recovery (unqualified)

## Governance

**The ask**:
What this paper seeks: conditional pilot approval only. Not a rollout, not a second FTE, not a second site.
_Avoid_: Proposal, request, business case (as a synonym)

**Locked**:
A number or offer term fixed for the pilot and not to be renegotiated mid-test. Tagged `Locked` in the document.
_Avoid_: Fixed, agreed, final

**Sensitivity**:
An alternative input run to test fragility (e.g. 2.0 outbound orders/year), never the base case.
_Avoid_: Scenario, what-if, upside case

**Month-6 rule**:
The three-way decision at the end of the pilot: **Scale**, **Extend / reprice**, or **Stop**, each with written conditions.
_Avoid_: Review, checkpoint, final gate

**Escalate**:
Take the pilot back to the board before spending further — triggered at $65,000 committed, or on any must-hit red.
_Avoid_: Flag, raise, report

## Flagged ambiguities

- **"Order"** means two different things. In the app, a customer's request for bins is a **Booking** (never "order"). In the business case, an **outbound order** is one $50 retrieval trip. Always qualify: "outbound order", never bare "order".
- **"Close-out" vs "Close"**. **Close** (app) ends a bin's lifecycle and returns it to inventory. **Close-out** (commercial) is the *customer-facing* event that usually causes it — the customer keeps the contents and stops paying. A borrow ends with a re-store, not a close.
- **"Position" vs "Location"**. A **Location** (app) is a specific rack slot with a barcode. A **Position** (business case) is a unit of purchased capacity. 500 positions bought = 500 locations barcoded.
- **"Account"**. The app avoids "account" for a **Customer** because customers never sign in. The business case uses **account** deliberately as the billing and demand unit. Both are correct in their own document; do not let "account" leak into app prose meaning a login.
- **"Stored bin" vs "occupied bin"**. Stored is a **bin status**; occupied is the billing state derived from it. They should always agree — if they don't, the invoice is wrong.
- **"Retrieval"**. A **retrieval request** (app) is the customer action; an **outbound order** (commercial) is the priced event it creates. One request, one order, many bins.
- **"Green"** is a metric verdict, never a description of cash. Cash has its own words: peak cash, exposure, payback.
