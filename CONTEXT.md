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
Staff who manage bookings, assign bins, cancel bookings, view stats, reset demo data, and provision other staff accounts.
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
