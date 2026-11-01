# Orders, payments, warehouse & installation schedule: setup

This module adds products, kit templates, quote acceptance, orders, payments, warehouse packing lists and the crew schedule to the CRM.

## 1. Run the SQL (Supabase → SQL Editor)

Run the files in this order. Every file is safe to run again.

1. `schema.sql`
2. `ai_calls.sql`
3. `minutes_meetings.sql`
4. `quotes.sql`
5. `auto_quotes.sql`
6. `surveys.sql`
7. `engineer_portal.sql`
8. **`orders.sql`** (new)

`orders.sql` does the following:

- **Survey stage:** adds the `survey_approved` lead stage.
- **Final-quote guard:** a final quote can't be created without an approved survey.
- **Roles:** adds the `warehouse` and `technician` roles.
- **Seeded data:** 20 demo products with opening stock, 10 kit templates (1–5 kW On-Grid / Off-Grid) and 3 placeholder crews.
- **Tables:** orders, payments, the private `receipts` storage bucket, and all automation and security rules.

> `orders.sql` calls the `send-whatsapp` function at `https://iekfgtyfwmplsauutegs.supabase.co/functions/v1/send-whatsapp` when an order is confirmed. If the project URL ever changes, update it in `public.confirm_order`.

## 2. Redeploy the Edge Functions

| Function (folder) | Deployed name | What changed |
|---|---|---|
| `supabase/functions/send-whatsapp` | `send-whatsapp` | New kinds `order_confirmed` and `receipt`; a customer's "yes" to the final quote accepts it and gets the payment details; estimates sent from the CRM |
| `supabase/functions/bolna-webhook` | `hyper-action` | New `survey_approved` stage |

- **JWT verification:** keep it **OFF** for both functions. The database calls `send-whatsapp` without a login, and only the order id is sent. The function re-reads the order itself and messages each order only once.
- **Secrets:** no new secrets are needed. The existing `TWILIO_*`, `GEMINI_API_KEY` and `BOLNA_WEBHOOK_TOKEN` are reused.

## 3. New Quote settings (CRM → Quote settings → *Orders & payments*)

| Setting | Used for |
|---|---|
| Advance to confirm an order (%) | Advance due on every new order (default **30**) |
| UPI ID | The UPI payment link and QR in the CRM, on receipts and in WhatsApp messages |
| Bank details | Receipts and the payment instructions sent on WhatsApp |

Product prices (excl. GST) and GST rates are set under **Products**.

## 4. Warehouse and technician logins

For each person:

1. Supabase → **Authentication → Users → Add user**, with their email and a password.
2. Add them to the staff list (SQL Editor):

```sql
insert into public.staff (email, name, role) values
  ('warehouse@yourcompany.com', 'Warehouse', 'warehouse'),
  ('ravi.tech@yourcompany.com', 'Ravi (Crew A lead)', 'technician')
on conflict (email) do update set role = excluded.role, name = excluded.name;
```

What each role sees after signing in at `/admin`:

- **warehouse:** only the Warehouse screen (packing lists and stock), with no prices or phone numbers.
- **technician:** only *My jobs*, their crew's installations with the items to carry, with no prices or phone numbers.
- **owner / manager / staff:** everything. Only owner and manager can cancel an order.

## 5. Crews

`orders.sql` creates **Crew A / B / C** with placeholder emails (`crew-a@example.com` …). Replace them with your technicians' emails:

```sql
-- Crew lead
update public.crews set lead_technician_email = 'ravi.tech@yourcompany.com' where name = 'Crew A';

-- Other members (they see the same jobs)
insert into public.crew_members (crew_id, staff_email)
select id, 'kumar.tech@yourcompany.com' from public.crews where name = 'Crew A'
on conflict do nothing;
delete from public.crew_members where staff_email like 'crew-%@example.com';

-- A crew you don't use
update public.crews set active = false where name = 'Crew C';
```

How auto-scheduling works:

- Each crew can take **1 full-day or 2 half-day jobs** per working day (Mon–Sat).
- On confirmation, the job is booked on the earliest free day from **3 days after confirmation** (tomorrow + 2).
- Systems up to 3 kW take ~4 h (half day). 4–5 kW take ~8 h (full day), and Off-Grid/Hybrid adds 2 h.

## 6. How it flows

1. **Survey approved** → *Prepare quote* builds the **final quote** from the nearest kit template, using the survey's panel count, cable lengths and structure height. Without an approved survey only an **approximate estimate** can be made.
2. **Final quote sent on WhatsApp.** The customer replies "yes", or staff click **Mark accepted**. The quote is accepted, the lead becomes **Won**, and order `SP-ORD-YYYY-0001` is created as *Awaiting payment*.
3. **Record payment** on the order:
   - a receipt `SP-RCPT-…` PDF is created, and can be sent on WhatsApp;
   - once the advance is reached the order is **confirmed**, stock is reserved and the packing list appears in the Warehouse;
   - the installation is auto-scheduled and the customer gets a WhatsApp with the date.
4. **Warehouse** ticks the items and clicks **Mark all packed**. The technician sees the job with the packed items.

> **Twilio sandbox note:** WhatsApp only allows free-form messages within 24 hours of the customer's last message. If the order-confirmation message fails, the lead's activity says why. Ask the customer to message the sandbox number, then send the receipt from the order.

## 7. TEST CHECKLIST

| # | Test | Where to look |
|---|---|---|
| 1 | Approve a survey → **Prepare quote**. The lines come from the **3 kW On-Grid** kit, with quantities and the survey's cable metres. | Lead → Survey & quote |
| 2 | Without an approved survey, only an **estimate** is possible. In the SQL editor, `insert into quotes (lead_id, kind, …) values (…, 'final', …)` fails with *A final quote needs an approved site survey*. | Lead → Survey & quote; SQL Editor |
| 3 | Send the final quote. The customer replies **"Yes, go ahead"** on WhatsApp. The quote is accepted, the lead is **Won**, and order **SP-ORD-…** is created (awaiting payment). The customer gets the payment details. | Orders; lead Activity |
| 4 | Record a **30% advance by UPI**: a receipt PDF is created and the order is confirmed. Then check stock reserved (Products), the packing list (Warehouse), the job (Schedule), the customer's WhatsApp and the activity log. | Order; Warehouse; Schedule; Products |
| 5 | Record the **same payment reference** again → blocked. | Order → Record payment |
| 6 | As **warehouse**: tick the items → **Mark all packed** → order = Packed. No prices or phone numbers are shown. | Warehouse login |
| 7 | As **technician**: only your crew's job, with the packed item list. | Technician login |
| 8 | **Reschedule** the job to a full day where the crew already has a job → conflict warning. | Schedule → click the job |
| 9 | **Cancel** an order (manager) → reserved stock goes back (Products → Reserved drops). | Order → Cancel order |
| 10 | Set a product's stock below its low-stock level (Products → Adjust) → red **Low** badge on Products and the Leads tile. | Products; Leads |

---

# Dispatch & installation (module 2)

## Setup
1. Run **`supabase/installation.sql`** in the SQL Editor, after `orders.sql`. It is safe to run again.
   > If you ever re-run `orders.sql`, run `installation.sql` again afterwards, because it upgrades some of the same functions.
2. Redeploy **`send-whatsapp`**, which has a new kind, `installation_complete`. Keep JWT verification OFF.
3. In Products, tick **Track serial numbers** for every item that needs one. Inverters, batteries and charge controllers are ticked already; panels are optional.
4. Optional: fill in the warranty fields in Quote settings. They appear in the WhatsApp message and on the installation certificate.

## How it works
1. **Warehouse, "Ready to dispatch" tab:**
   - Scan each serial number. A USB or Bluetooth scanner types it and presses Enter. On a phone with Chrome, use 📷 to scan with the camera.
   - The **Dispatch** button stays locked until every serial number is scanned.
   - Enter the vehicle number and driver, then click **Dispatch**. The stock leaves the shelf, and a delivery note PDF with the serial numbers is available.
2. **Technician, My jobs:**
   - Once the order is dispatched, **Start installation** opens the on-site form.
   - The form has an 8-point checklist, at least 3 photos, the generation reading from the inverter, notes, and the customer's name and signature.
   - **Save progress** works any time; **Complete installation** finishes the job.
3. **On completion, automatically:**
   - the order becomes **Installed**;
   - the customer gets a WhatsApp with the generation reading, balance due (with the UPI link), warranty and subsidy next steps;
   - the activity is logged.
4. **Office:** when the balance is fully paid, the order becomes **Completed**. The order page shows the dispatch details, serial numbers, photos and signature, and a **Completion certificate (PDF)**.

## Rules
- Each serial number can only go out once (per product). A cancelled order frees its serial numbers.
- An order can't be cancelled after dispatch.
- Only the job's own crew can start or complete it.
- Photos are stored privately and are visible only to the office and that crew.

## Test checklist (module 2)
| # | Test |
|---|---|
| 1 | Packed order → **Ready to dispatch**: Dispatch is locked until the inverter serial is scanned |
| 2 | The same serial on another order is refused ("already used on order …") |
| 3 | Dispatch → order **Dispatched**, stock goes down, delivery note PDF shows the serials |
| 4 | Technician: "Waiting for dispatch" before step 3, **Start installation** after |
| 5 | Complete with an item unticked, fewer than 3 photos or no signature → refused with a clear message |
| 6 | Complete properly → order **Installed**, customer WhatsApp received, activity logged |
| 7 | Record the final payment → order **Completed** |
| 8 | Office: photos, signature and the **Completion certificate (PDF)** |
| 9 | Try to cancel a dispatched order → refused |

---

# After-sales service: breakdown tickets, pre-monsoon checkups, customer portal (module 3)

## Setup
1. Run **`supabase/service.sql`** in the SQL Editor, after `installation.sql`. It is safe to run again.
   > The full order is `orders.sql` → `installation.sql` → `service.sql`. If you re-run an earlier file, run the later ones again too.
2. Redeploy **`send-whatsapp`**, which has a new kind, `ticket`. Keep JWT verification OFF.
3. Deploy the **new** Edge Function **`customer-portal`** from `supabase/functions/customer-portal/index.ts`, with JWT verification **OFF**. It uses the existing Supabase secrets and needs nothing new.
4. Quote settings → **After-sales service**:
   - workmanship warranty (months, default 60);
   - visit charge for out-of-warranty visits (₹, default 500).
5. The portal page is `/portal/` next to `/admin/`. Customers can only open it once the site is hosted online; on `localhost` only you can open it.

## How it works
- **Customer portal:**
  - Lead → **Portal link** creates a private link, which you send on WhatsApp. A new link stops the old one working.
  - The customer sees their system, serial numbers, warranty dates, payments (with UPI pay), documents and their service requests.
  - **Report a problem:** the customer picks a problem, writes a few words and adds up to 4 photos. They get a ticket number on WhatsApp, plus safety advice for sparks, water or tripping. Once it's resolved, they rate the service with 1–5 stars.
- **Warranty:** checked automatically.
  - Inverter faults use the inverter's warranty months. Other faults use the workmanship warranty.
  - Storm or physical damage is "not covered".
  - Expired or not covered → the visit is chargeable: parts plus the visit charge.
- **Response deadlines:**
  - Urgent 4 h (sparks, smoke, shock)
  - High 24 h (no generation, water leak, tripping)
  - Normal 3 days
  - Low 1 week
- **Overdue tickets** turn red on the Service screen and on the Leads tile.
- **Service screen (office):** dashboard with open, overdue, due today, resolved this week, average fix time and rating; breakdowns by problem and by area; campaign progress.
  - From a ticket: assign a crew, date and slot (with a clash warning against installations), change the priority, resolve over the phone, close or cancel it.
- **Pre-monsoon campaign:** creates one free checkup for every installed customer in the date range.
  - Up to 4 checkups per crew per day, around installations; never on Sundays.
  - Customers who already have a checkup booked are skipped.
  - Each customer gets a WhatsApp with their date. Anything that doesn't fit is left as "Not scheduled" for you to book.
- **Technician:** "Service visits" appear under My jobs.
  - Safety checks first.
  - The visit form has the cause and work done (or the 8-point monsoon checklist for checkups), parts used (taken out of stock), before/after photos, the generation reading and the customer's signature.
  - **Complete** → the ticket is resolved and the customer gets a WhatsApp.
- **Schedule:** service visits appear on the week view next to installations.

## Test checklist (module 3)
| # | Test |
|---|---|
| 1 | Lead → **Portal link** → open it: system, warranty, payments, documents shown |
| 2 | Portal → **Report a problem** (Water leak + a photo) → ticket number shown; WhatsApp with safety advice; ticket on the Service screen as High, due in 24 h |
| 3 | Inverter fault on a system older than 24 months → "Warranty expired", chargeable |
| 4 | Assign Crew A + date → customer WhatsApp "visit booked"; the visit shows on the Schedule week view |
| 5 | Technician: start the visit (safety), add before/after photos and a part, generation, signature → resolved; part taken out of stock; customer WhatsApp |
| 6 | Portal: rate the visit → ticket closed; rating on the Service dashboard |
| 7 | Leave a ticket past its deadline → red "Overdue" on Service and the Leads tile |
| 8 | **Pre-monsoon campaign** → checkups booked across crew days (max 4 a day), WhatsApp to each customer |
| 9 | Technician completes a checkup: all 8 monsoon checks required |

---

# Director's month-end dashboard (module 4)

## Setup
1. Run **`supabase/director.sql`** in the SQL Editor, after `service.sql`. It is safe to run again.
2. Press Ctrl+F5 in the CRM. A **Director** tab appears for the **owner and managers only**. Office staff, the warehouse and technicians don't see it, and the database refuses them too.

## What it shows (pick any month; everything compares with the month before)
- **Needs attention:** overdue service tickets, orders short of stock, packed orders waiting for dispatch, surveys waiting for approval. Click one to go straight there.
- **Headline tiles, with ▲/▼ versus last month:**
  - orders booked (₹, count, kW);
  - cash collected;
  - money owed today;
  - gross margin (order value excl. GST minus product cost prices, before overheads);
  - new leads (with AI calls and % won);
  - kW installed (with days from confirmation to installation);
  - service tickets (resolved, % on time, checkups);
  - customer rating.
- **Sales funnel:** this month's leads → survey booked → approved → quote sent → won.
- **Leads by source**, and **6-month trends** for orders, cash and leads.
- **Money owed by age** (0–30 / 31–60 / 61–90 / 90+ days) and stock value at cost.
- **Crews:** installs, kW, service visits and rating per crew. **Biggest orders** of the month.
- **Export:** **Month-end report (PDF)** to share with the board, and **CSV** for Excel.

Every chart shows exact figures on hover (or on keyboard focus) and has a "Show table" view.
Gross margin uses the **cost price** in Products, so keep cost prices up to date.

---

# Money & people (module 5): profit per job, GST invoices, subsidy, technician pay

`supabase/finance.sql` runs after `director.sql`; it is safe to run again. `send-whatsapp` gains the `invoice` kind.

**Before the first real invoice, in Quote settings:**
- fill in **GSTIN**;
- check **Invoices & costs**: invoice prefix, your state, crew cost per hour, and the SAC codes for installation and repair lines;
- check every product's **HSN code** (Products → edit).

The defaults are sensible starting points; confirm them with your accountant.

- **Technician hours:** logged automatically for everyone on the crew when an installation or service visit is completed, rounded to ¼ hour. Correct or add hours on **Team** (owner and managers only).
- **Pay sheet (Team):** monthly salary + bonus per installation + bonus per visit + hourly pay, set per person with "Rates". "Record pay" saves the payout for the month.
- **Profit per installation:** revenue excl. GST − parts at **cost price** − crew hours × cost per hour − other job costs (transport, DISCOM fees… added on the order) − free warranty repairs. Shown on each order and on the Director dashboard; loss-making jobs are red.
- **GST tax invoices:**
  - *Orders:* the order → "Issue tax invoice" (after dispatch), with the full billing address and the customer's GSTIN if any. CGST + SGST within the state, IGST across states.
  - *Repairs:* out-of-warranty repairs get a tax invoice **automatically** when resolved. Mark it paid when collected.
  - *Numbering:* SP/2026-27/0001, per financial year, with no gaps.
  - *Changes:* issued invoices can't be edited; a manager can cancel one with a reason and issue a new one.
- **Subsidy (PM Surya Ghar):** a case opens by itself when an order with a subsidy is confirmed, and "Installed" ticks itself.
  - On **Subsidy**, fill in the date of each step: registration, feasibility, inspection/net meter, claim, credited. Also record the application number, net meter number and the documents collected.
  - Cases with no progress for 3+ weeks are flagged.

---

# Remaining pieces (module 6)

`supabase/extras.sql` runs after `finance.sql`; it is safe to run again. Redeploy `send-whatsapp` and `customer-portal`.

**Full run order:** schema → ai_calls → minutes_meetings → quotes → auto_quotes → surveys → engineer_portal → orders → installation → service → director → finance → extras.

- **Stock purchases:** Products → **Record purchase**: supplier, GSTIN, bill no/date, items at cost, GST.
  - Stock goes up, and each product's cost price becomes the weighted average, so job profit uses real costs.
  - The same supplier bill can't be entered twice. Purchases show on the Director dashboard.
- **Warranty per serial number:**
  - The clock starts by itself at **delivery**, when the crew starts work on site. The office can also click "Mark delivered" on the order.
  - Warranty lengths come from each product (inverter/battery 24 months, panels 240). Panels scanned on the roof get theirs immediately.
- **Find a customer in seconds:** Service → "Customer calling?" search by serial number, phone, client ID or name. It shows every unit with "In warranty until …" or "Expired", and **New ticket** opens straight from the result.
- **Ticket warranty from the exact unit:** an inverter fault picks the system's inverter serial automatically; the unit can be changed on the ticket. Free if that unit is in warranty, chargeable (with an automatic invoice) if not.
- **Tickets close only when the customer confirms:** by rating on the portal, or "Customer confirmed it works" after a phone call. How it was confirmed is recorded.
- **Confirm installed size:** the crew confirms the installed kW before completing. A size different from the order is flagged to the office.
- **Director:** **Today / This week / Month** switch for the headline figures and profit per job.
- **Leads:**
  - the full address can come from the website form;
  - the grid check ("Grid connection suitable?") is in Requirements.
- **Packages:**
  - On-Grid kits now include a battery charge controller, as the package list describes; remove it in Kit templates if not wanted.
  - New 1–5 kW **Solar Panel Set** kits (panels, connectors, wires + installation); in the survey, choose "Solar panel set only".
- **WhatsApp enquiries from new numbers:** Quote settings → WhatsApp enquiries. Both settings are off by default:
  - when on, a message from an unknown Indian number creates a lead and gets a welcome reply;
  - the AI agent only calls those leads if the second box is ticked too.

# Localhost users: the customer's own login (module 7)

## Setup
1. Run `supabase/passport.sql` after `extras.sql`. It is safe to run again.
2. Redeploy `send-whatsapp` and `customer-portal`.
3. Optional: Quote settings → WhatsApp enquiries → **Localhost users address**. This is the link sent to customers with their login. Without it, the message uses `http://localhost:8080/portal/`.
4. For the demo, start the site with `python serve.py` instead of `python -m http.server 8080`. The built-in server queues only 5 connections, so a CRM page sometimes failed to load one of its scripts.

**Full run order:** schema → ai_calls → minutes_meetings → quotes → auto_quotes → surveys → engineer_portal → orders → installation → service → director → finance → extras → passport.

## How it works
- **Automatic login:** when an order becomes **Completed** (final payment recorded), the customer's login is created.
  - It is sent once on WhatsApp: the passport address, the phone number, and a one-time password.
  - A customer's second order adds to the same passport, with no new password.
- **First sign-in:** the customer opens `/portal/` and signs in with their phone number (or client ID) and that password. They must then set their own password (8+ characters, different from the one sent).
- **The passport shows:**
  - warranty cards for every unit, with serial numbers, start date, end date, time left and Active/Expired status;
  - installation workmanship;
  - the installation record: date, crew, installed kW, generation at handover, who signed, site photos;
  - PM Surya Ghar subsidy progress;
  - payments, quotation, tax invoices and receipts;
  - service requests, with **Report a problem**;
  - a QR code.
- **Warranty card PDF:** made on the phone, one page with all units and serials, the QR code and the claim instructions.
- **Office:** lead → **Localhost users** shows the username, status and last sign-in. Use **Send a new password** when a customer forgets theirs:
  - the new password goes on WhatsApp and is shown once on screen, so staff can read it out;
  - it signs the customer out of every device.
- **The private portal link still works** alongside the login.

## Security
- Customers are not CRM users. They sign in only through the `customer-portal` function, so a customer login can never open the CRM.
- Passwords are stored as bcrypt hashes only, and sessions as SHA-256 hashes (30 days). Passwords never appear in the activity log.
- Five wrong passwords lock that login for 15 minutes.
- Only owner, manager and office staff can make a new password; warehouse and technicians can't.
- Staff can see whether a login exists, never the password hash.

## Demo login
The demo customer's sign-in details are shared separately. They are not kept in this repository.
