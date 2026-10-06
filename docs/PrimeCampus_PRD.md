# PrimeCampus — Product Requirements Document

Version: 1.2
Date: 5 October 2026
Release: V1, first-school launch
Status: product baseline for review and implementation planning

This document consolidates the founder's requirements and accepted decisions. It supersedes conflicting product proposals in the earlier VidyaOS/PrimeCampus documents. It defines what the product must do. Architecture, database implementation, authentication configuration, deployment and agent work allocation belong in the subsequent TRD and related specifications.

## 1. Product purpose

PrimeCampus is a multi-tenant school operations web portal for Indian schools. It connects student records, enquiries/admissions, fees, teaching schedules, attendance, diary/homework, staff attendance and a salary calculator. A real first school will use the product.

The product must fit staff routines: office staff handle admissions and collections; teachers mark attendance and check homework, sometimes recording their observations later; management reviews information appropriate to its role. School setup is configurable, while daily actions are short and understandable.

V1 success means these connected workflows work reliably for the first school. It does not require every module marketed by established ERPs. A three-hour parallel build is a development target, not evidence of production readiness. The acceptance scenarios in this document determine whether the first release is ready.

Launch planning assumes one school with approximately 800 students, an online-only responsive web portal and an English interface. The founder requests a zero-recurring-cost starting deployment within provider free-tier limits. Detailed capacity and performance feasibility belong in the TRD.

## 2. Scope summary

### 2.1 Included

- Organizations with one or more schools; Operator access across the platform.
- User provisioning, username/password experience, multiple roles/schools per account, parent-child selection and account recovery.
- School identity, timings, periods/breaks, academic years, separate student/staff calendars, classes, sections, class subjects and teacher assignments.
- Existing-data spreadsheet imports with mapping, preview, validation and import results.
- Student/guardian text records, admission forms and current enrollment/placement.
- Manual admission enquiries, sources, follow-ups/contact history and conversion to enrollment.
- Individual and bulk class/section shuffling with an effective date and preserved history.
- Weekly timetable, date-specific teaching schedule, teacher-absence flags and Admin-selected substitutions.
- School-selectable day-wise or period-wise student attendance; historical views and reports.
- Separate Diary and Homework pages, teacher checking and parent/student progress views.
- Fee heads, collection bank accounts, terms, fee structures, concessions, manual adjustments, fixed late fees/waivers, fee demands/invoices, partial collections, cheque lifecycle, receipts and dues reports.
- Staff groups, staff records, attendance, distinct calendars and configurable monthly salary calculator with paid leave and reference bank details.
- Role-specific dashboards/reports and private operational records, printing, on-demand data exports, account recovery and traceable corrections.
- Operator-only authentication, business audit and basic portal-activity visibility.

### 2.2 Deferred

Exams, marks, report cards, rankings, hall tickets; WhatsApp/SMS/email notification sending; public admission enquiry form; voice agents and learning/risk AI; biometric/RFID integrations; library; GPS/bus operations; ID-card designer; transfer certificates; formal withdrawal/re-admission/promotion/retention/graduation workflows; salary disbursement and statutory payroll; employee leave requests; online fee gateway; advances/excess-credit wallet; refund execution/standalone external-refund workflow; automatic platform subscription billing; complex daily/compounding late fees; automated tax calculation or tax filing.

Transport may be charged as a fee without a transport-management module. Staff may record that an enquiry came from a website without building a website enquiry integration. Calendar exam-day labels are allowed without building exams. Changing the current year does not automatically promote students.

Automated backups and restore tooling are deferred by the founder's latest instruction. On-demand exports remain required. Offline operation and additional interface languages are outside V1.

Latest storage scope: text/data records only. Student/staff photos, stored scanned documents and diary/homework file attachments are deferred. Spreadsheet imports may process uploaded files temporarily; receipts and data exports can be generated on demand from stored records.

## 3. Product hierarchy and terminology

| Term | Meaning |
|---|---|
| Operator | Top platform role; access across organizations, schools and role contexts |
| Organization | Customer/ownership group containing one or more schools |
| School | Institution whose operations and data are separately scoped |
| Academic year | School-chosen date range and label; one current default |
| Class | Grade level, such as Class 1 or Class 10 |
| Section | Named, year-specific group within a class |
| Enrollment/placement | Student's school/year relationship and dated class/section membership |
| Teaching assignment | Teacher's subject/section responsibility; distinct from class-teacher duty |
| Timetable | Recurring weekly plan |
| Lesson session | Teaching occurrence on an actual date and period, including any override/substitute |
| Fee invoice/demand | What a student owes |
| Payment/collection | Money received and verified/cleared |
| Receipt | Evidence of a posted collection; not a new charge |
| Salary calculation | Recorded estimate of what the school owes staff; no movement of money |

Organization and school may share a name but remain separate identities. Names and roll numbers are not stable identifiers. A student has a school-unique admission number and a roll number appropriate to their placement. Corrections must preserve connected history.

## 4. Roles and access boundaries

There are eight named roles including Operator: Operator, Owner, Admin, Principal, Accountant, Teacher, Parent and Student. A person can hold several scoped roles. Each role's interface uses its own granted permissions; switching contexts must not transfer privileges to another school or child.

| Role | View | Manage |
|---|---|---|
| Operator | Platform and all schools, users, operational records and raw logs | Platform onboarding/user support and all operational contexts; actions recorded as Operator |
| Admin | All school operational modules and confidential salary/bank details | All school setup, accounts, imports/admissions, placements, schedules/substitutions, attendance, diary/homework, fees and staff calculator |
| Accountant | Fees, collections, concessions, dues, fee reports and necessary student identification | Fee configuration, concessions, collections and reversals of incorrect collections; no approval queue |
| Principal | Student/teacher attendance, timetable, teaching records, diary/homework and academic views | Read-only |
| Owner | Assigned schools' fees and HR/salary/bank details, school/staff attendance summaries | Read-only |
| Teacher | Applicable students/lessons and diary/homework; own operational staff attendance | Attendance, diary and homework/checking within teaching/class-teacher/substitute responsibility |
| Parent | Only linked children's permitted profile, timetable, attendance, fees/receipts and diary/homework | No school operational edits |
| Student | Own permitted profile, timetable, attendance, fee documents and diary/homework | No school operational edits |

Admin full access is confined to granted schools and excludes Operator-only raw logs. Accountant cannot see staff salary/bank details. Principal cannot perform substitutions or staff-attendance edits, and cannot see salary/bank details. Owner cannot open detailed diary/homework. Teacher cannot see salary/bank records or request leave in V1.

Class-teacher duty provides section oversight, daily attendance responsibility and section homework checking. Subject teachers record/check their subject assignments. An approved substitute receives operational access for assigned sessions; substitution alone does not provide permanent section-wide rights. Permissions are enforced on records and exports, not only by hiding navigation.

## 5. Access and user management

### ACCESS-01: Sign-in experience

School-issued username and password. Supabase Auth is the selected service. Users need not own personal email inboxes; the technical document will specify the internal identifier mapping and provisioning process. No public self-registration is required. Display understandable sign-in errors without exposing unrelated accounts.

### ACCESS-02: Context and child selection

After successful sign-in, show available role/school choices when more than one exists. Example: Teacher — School A and Parent — School A. Single-context users enter directly. Keep a visible Switch role/school action.

Parents with multiple children see cards showing each child's name, school and class/section. Selecting a child opens that child's view. Keep a Switch child action; one linked child may open directly. Switching must clear old child/context data before displaying the next context.

### ACCESS-03: Account administration

Admin can create/provision school accounts, link appropriate people, assign/revoke school memberships, disable school access and issue logged recovery credentials. Operator has platform-wide support access. Existing people must not require duplicate accounts for new roles or sibling links. Shared family contact numbers must not accidentally merge distinct guardians.

Disabling school membership must preserve historical authorship and must not remove the same person's valid access to unrelated schools. Password changes/recovery have a clear user flow. Temporary credentials should be replaced on first use. Passwords are never shown in audit history.

## 6. School and academic setup

### SETUP-01: School information

School name, code, organization, contact phone/email, address, logo and applicable official school identifiers. Each school configures its own identity; school edits do not alter other schools.

### SETUP-02: Operating schedule

Set student school-day boundaries, working weekdays/Saturdays and ordered periods/breaks. Add/edit names and start/end times. Breaks do not receive subject attendance. Periods must have valid non-overlapping times within the operating schedule. School can use quick presets and then customize.

Changes apply from a chosen effective date and preserve previously recorded session times. Staff operating calendars are separate, including group-specific working patterns where needed.

### SETUP-03: Academic years

Admin creates year name/start/end dates and selects one current year. Default queries use current year; authorized users can view history. Switching year must not hide unsettled old fees or reinterpret old attendance. Creating/selecting a year and assigning students to that year's sections are separate actions. Automatic promotion is deferred; V1 supports explicit placement entry/import.

### SETUP-04: Calendars

Interactive annual/monthly calendar with working, holiday/off, half-day, special and exam labels. Set defaults in bulk; change dates individually or mark a date range. Include label/reason, affected audience, clear totals and save feedback. Student and staff calendars are independently managed; staff/groups can work on a student holiday.

Operational meaning must be visible: whether lessons/attendance are expected and which periods apply on a half-day. Event labels may coexist with working status. Dates outside the selected year's scope must not become attendance days accidentally. Past-date changes show affected recorded information for deliberate correction rather than silently deleting it.

### SETUP-05: Classes, sections and subjects

Admin creates ordered classes, custom section names for each year, class-teacher assignments and class-specific subjects/codes. Duplicate conflicting names/codes must be explained. Active referenced configuration can retire without erasing historical records. Subject requirements can differ by class; no hardcoded national subject list.

## 7. Student information and imports

### SIS-01: Student and guardian record

Admission form covers student identity, date of birth, admission/joining date, contact/address, prior school and relevant academic details. Guardian records include names, relationship, contacts and applicable occupation/income/reporting information. Link more than one guardian and several siblings, and identify primary contact.

Student search supports admission number/name and class/section filters. Similar names show distinguishing class/section/admission information. Profile views organize personal/guardian information, placement, fees, attendance, and diary/homework links according to permissions. Store date of birth; derive age for a stated date.

Use the current applicable official Telangana/UDISE+ student field mapping, with required/optional fields, code lists and year-specific reporting values explicitly documented before implementation. The field dictionary is a delivery dependency, not permission to copy unverified old field lists. Basic operational enrollment need not be blocked by incomplete reporting-only fields unless the verified requirement requires it. Do not claim government API synchronization or generation of PEN/APAAR IDs.

Sensitive identifiers and financial details are restricted by purpose and role. Ordinary teachers/parents must not automatically receive every government-reporting field merely because they can view a profile.

### SIS-02: Placement and shuffling

Admin assigns school/year/class/section with effective joining/placement dates. Individual and batch move between classes/sections: select students, destination, effective date and reason, preview changes/conflicts, then apply. Validate roll-number conflicts and avoid overlapping placements. History before the move remains attached to the original section. Class changes show fee implications; old invoices are not recalculated automatically.

Formal withdrawal/re-admission workflow is deferred. Basic archival/access deactivation preserves history and allows staff to stop future participation for an inactive record without deleting it; detailed transfer/TC rules are not part of this release.

### IMPORT-01: Existing-data onboarding

Import spreadsheet data for classes/sections, staff, students, guardians, placements and opening fee balances. Support XLSX and CSV. Provide template/column mapping, school/year context, validation preview, duplicate detection, row errors and counts.

Correct or remove draft rows before confirmation. The final result identifies imported/rejected records with reasons. Repeating an import must not duplicate people, placements or debts. No unconditional wipe-and-reimport action. Existing-record updates must be explicit in the preview. Opening debts retain their source/year and cannot be charged a second time through invoice generation.

## 8. Admissions enquiry workflow

### ADM-01: Manual leads and follow-ups

Staff with assigned admissions duty and Admin enter every enquiry manually, including those received from a website. Record parent/contact name, phone, child name if known, interested class, source, assigned handler, notes and next follow-up date. Source examples: walk-in, website, referral/word of mouth and phone. Sources do not imply automated integrations.

Simple stages: New, Contacted, Visited, Converted/Admitted and Lost. Log contact attempt time, outcome, note and next follow-up. Show overdue/today/upcoming follow-ups. A household phone can produce more than one legitimate enquiry; suggest possible duplicates instead of automatically merging them.

### ADM-02: Conversion and direct admission

Convert lead: complete student details, link guardians/parent accounts, assign year/class/section, apply standard fees and confirm enrollment. Show the connected student after conversion. Retry/opening the converted lead must not create another student. Conversion errors must show what remains incomplete; do not label a lead admitted without a real connected student/placement.

Direct admission without a prior lead remains available to Admin/assigned admissions staff. Admissions duty is a scoped capability on an existing role, not a new platform role. Until explicitly delegated, Admin is the default handler.

## 9. Timetable and substitutions

### TIME-01: Recurring timetable

Weekly section grid with academic year, days, named periods/times, breaks, subject and teacher. Admin creates/edits and can copy a suitable section timetable with validation. Teachers, students and parents see appropriate schedules; Principal views the school's schedules.

Timetable checks actual time conflicts, not just period numbers, across the teacher's assignments. Unassigned periods are visibly incomplete, not assumed holidays. Admin maps the teacher's subject/section responsibility and effective dates.

### TIME-02: Actual date view

For a selected date, resolve calendar, effective timetable, section and period into actual lessons. Support date-specific subject/teacher/time overrides and cancellation without changing the entire weekly plan. Preserve planned versus actual teacher and historical schedule. Two same-subject periods are distinct lessons.

### TIME-03: Substitution

Admin marks staff presence/absence manually. Recorded teacher absence flags affected lessons. Suggest teachers without conflicting lessons/substitutions and without recorded absence. Show availability information; unknown presence must not be labelled confirmed available.

Admin selects any eligible teacher and can replace the assignment. Conflicts are visible; an exceptional conflicting assignment requires a deliberate reason and must not be silently presented as conflict-free. Record who assigned/replaced the substitute and when. The substitute can perform the assigned lesson's attendance/diary/homework duties. No automatic substitute assignment or biometric ingestion in V1.

## 10. Student attendance

### ATT-01: School-selected mode

School selects day-wise or period-wise. Mode changes have an effective boundary and do not rewrite prior data. Both modes coexist historically without duplicate counting. Timetable, diary and homework remain usable in day-wise mode.

Day-wise: authorized class teacher/Admin selects date/section and marks one record per eligible student. Period-wise: assigned teacher/substitute/Admin selects the actual lesson and marks one record per eligible student. Default is Unmarked. Provide Mark all present, edit exceptions, Save/Submit and a clear completion indicator.

### ATT-02: Scoring

Day-wise Present/Late = 1; Half-day = 0.5; Absent = 0. Period-wise Present/Late = 1; Absent = 0 per eligible held session. There is no period Half-day mark; half-day operating schedules determine which sessions exist.

For a fully marked range, percentage = attended units / eligible units × 100. Unmarked units are displayed separately. If incomplete, show marking coverage and label any percentage as provisional/for marked records; do not label it final or silently treat unmarked as zero. Holidays, weekly offs, cancelled lessons and periods outside student placement eligibility do not count. Attendance starts at joining date. Excused-absence weighting is deferred.

### ATT-03: History and corrections

Teacher can correct their authorized records; Admin can correct school records. Capture actor, time and changed values. Relevant history filters date/year/class/section/subject/student. Parent/student view only own applicable records; Principal reads school attendance; Owner gets summaries. No automatic absence alerts.

## 11. Diary and homework

### DIARY-01: What was taught

Separate Diary page. Entry identifies school/year, date, actual lesson/period, class/section, subject, teacher and topics/explanation. A lesson entry is shared with its applicable students rather than repeated once per student. Teachers may record it during leisure or later. Store lesson date separately from entry/update time.

Teacher/substitute records their lesson; Admin can correct. Principal reads teacher explanations/history. Parents/students see relevant class/child entries. Diary does not become visible to unrelated children or Owner. Missing entries show as missing, not proof a lesson did not happen.

### HW-01: Assignment

Separate Homework page linked to Diary/lesson, with subject/section, description, assigned date, due date and assigning teacher. More than one assignment is allowed when needed. Show pending checks and due work. No requirement for student uploads or parent completion buttons.

### HW-02: Teacher classroom checking

Example workflow: Class 2A social teacher checks 30 students during the first ten minutes, then records results during a free period. Display a class roster with quick per-student completion ticks and correction/checking controls, avoiding repetitive profile navigation. Class teacher can review/check section homework; subject teachers check their subject's homework; Admin can correct.

Each eligible student has Unchecked, Checked—Completed or Checked—Not completed. Record observation/check date, person checking and entry time; allow subsequent update when work is completed. Correction-required/completed/not-yet-checked states are distinct from initial homework completion. Class-level assignment is not duplicated for every learner.

### HW-03: Parent/student and Principal visibility

Parents see assignments, teacher-recorded completion/checking, correction status and date-filtered progress for the selected child. Principal views section/teacher homework and checking summaries. Show known late completion only when supported by a recorded completion date; otherwise say completed/observed after due date. Upload time alone must not prove a child's delay. Missing homework checks are distinct from missed homework.

If a student moves section, old applicable assignments/checks remain visible in history and new assignments follow destination eligibility. Work assigned before admission is not automatically classified as missed homework.

## 12. Fees and collection

### FEE-01: Configuration

Admin/Accountant configure heads, school receiving accounts, ordered terms/due dates and amounts by class/head/term/year. Mandatory/optional meaning has clear precedence; optional charge applies only to selected eligible students. Head/account retirement preserves old receipts/history. Missing price is visibly different from a configured zero amount.

Fee preview shows charge breakdown, concessions, adjustments and net total. Mid-year students receive the same standard class fees as full-year students: no automatic prorating. Admin/Accountant may make an explicit recorded adjustment. Additional charges can be entered with a label/reason. The founder's mention of taxes does not authorize automatic tax rules; any school-required tax display needs separately verified configuration in the TRD/fee specification.

### FEE-02: Concessions and fixed late charge

Named reusable concession presets, with fixed or percentage reduction and applicable heads/terms. Admin/Accountant can grant/change them directly; capture reason/person/time. Percentage bounds, applicable base and order are explicit so the same inputs produce the same total. Do not allow net dues below zero. Post-issue changes create a recorded adjustment; never silently overwrite a parent's existing issued document.

Configure a fixed late charge after due date/grace period and allow waiver with reason. V1 baseline is one fixed charge per affected invoice/term under the configured rule, not a daily/compounding fine. Re-running evaluation cannot duplicate it. Pending/unverified payment and cheque-bounce situations must be visible for operator review of dues rather than hide behind Paid.

### FEE-03: Invoice and statement

Generate charges for eligible students with preview and duplicate protection. Issued invoice snapshots fee heads/amounts/concessions/due date and student/school details. Standard pricing edits do not change already issued obligations. Distinguish document validity from Unpaid/Partial/Paid and overdue condition. A zero-value invoice is not overdue merely because no payment exists.

Student statement contains charges, applied concessions/adjustments, allocations, collected amounts, pending cheques, reversals and remaining dues, including imported opening balances from prior years. Current academic-year switch must not erase dues.

### FEE-04: Manual collection

Cash: select student/invoices, enter amount/date/collector and allocate, then issue receipt.

QR/manual bank collection: verify receipt of money in the school's receiving transaction record; enter account, amount, date and external reference where available, verifier/time, then post/allocate and issue receipt. Parent screenshot is evidence supplied, not automatic verification. Duplicate references/entry retries cannot post the same transaction twice.

Cheque: record cheque/reference/date/account and pending status. Pending does not settle dues. Clearing posts the collection; bounce leaves dues unpaid or reverses a previously posted collection. Preserve cheque lifecycle/evidence.

Partial payment is normal. A verified collection can allocate across the student's invoices; totals must agree. No advance/excess-credit wallet. Reject an allocation above remaining dues. Actual external overpayment becomes an explicit exception for the school to handle; never erase evidence or pretend excess settled a nonexistent invoice. Separate sibling students retain separate dues/allocation even when paid by one parent.

### FEE-05: Corrections and receipts

Admin/Accountant can reverse incorrect posted collections with reason and original reference, without approval queue. Original evidence remains. Reversal cannot exceed the still-reversible amount or belong to another student/school. Financial correction is not an automatic refund or proof cash left the school.

Sequential, school-scoped receipt number, original date, student, breakdown, amount, method and collector. Print/download/reprint issued content consistently. Corrections visibly relate to the original document; never reuse an issued number for a different transaction. Do not promise legally gap-free numbering without a verified requirement. Persist original displayed content/template version for faithful reprints.

### FEE-06: Reports

Daily collection totals by channel/collector/account; outstanding by student/class/section/term; fee-head totals; concessions/waivers; pending/bounced cheques; corrected/reversed collections; date-range collection trends. Filters and exports. Summaries reconcile with detail; pending collections excluded from posted totals. Owner views fees; Accountant/Admin manage; parent/student view own statements/receipts.

## 13. Staff attendance and salary calculator

### STAFF-01: Staff master and calendar

Admin creates arbitrary groups, such as high-school teaching, primary, non-teaching or sports. Staff can exist without a login. Teacher is also a staff member, not a separate duplicate employee. Record employee number, name, group, joining information, monthly salary and reference bank account/IFSC/name where applicable.

Separate staff/group working calendar independent from students. Admin marks daily staff attendance manually; Principal can view attendance but not edit. Unknown presence remains unmarked. Half-days are fractional attendance. Teacher absence feeds substitute suggestions.

### SAL-01: Calculator

Admin selects month/staff/group, uses calendar-derived working days and attendance, enters approved paid leave used, and may override values with a reason. Owner views results. No leave request/approval portal or automatic leave-balance accrual/carry-forward. Salary/group defaults can prefill but employees retain their actual salary.

Formula: payable = monthly salary × paid day equivalents / working day equivalents. Paid day equivalents = attended day equivalents + recorded paid leave. Holidays already excluded from denominator. Prevent overlapping holiday/present/paid-leave counting, negative values and paid days above working days. Round final amount to paise consistently.

Confirmed example: salary ₹40,000; working days 20; attended 15; paid leave 1; unpaid days 4; payable ₹32,000.

Show salary, working days, present/half-days, paid leave, unpaid days, deductions and final calculation. If calendar/attendance is incomplete, show discrepancies for Admin review. Zero working days requires an explicit manual resolution rather than dividing by zero. Mid-month employment changes use a previewed eligible-days calculation/manual adjustment rather than silently applying a full month.

Save/export a dated calculation snapshot. Later salary/calendar changes do not silently rewrite a saved finalized result. Corrected calculations preserve a version/reference. Bank details are reference only. No transfers, cheque issuance, payslip compliance, PF/ESI/TDS or automatic deductions. Confidential salary/bank data visible only to Admin/Owner and Operator, including exports.

## 14. Operator console and activity visibility

### LOG-01: Authentication and account history

Operator sees available sign-in/sign-out/reset events, account identity, school/role contexts, session identifiers, timestamps, outcomes and available browser/OS/device information. Track account provisioning, membership changes, disable/reset actions and relevant failures. Failed sign-in may have no verified person identity; do not falsely attribute it.

### LOG-02: Business and access events

Record meaningful operational changes, imports/uploads, lead conversion, attendance edits, diary/homework checks, fee setup/collection/reversals, salary calculations, role/child switches and relevant record views/download requests. Identify actor, target, school/year/context when applicable, action, time, result and appropriate redacted change detail. Operator actions are logged too.

### LOG-03: Basic usage

Page opened, last activity, logins, active users over selected range, browser/device class and estimated usage. Exact attention time, exact physical device identification and guaranteed browser-close time are not requirements. Distinguish authenticated session, last seen and estimated active use. Several tabs must not simply multiply estimated usage.

Raw logs are Operator-only, searchable by account/school/time/action/record/session. School roles may see ordinary business status/author information where needed, not the raw audit console. Log secrets and full sensitive identifiers are excluded. Log retention, export volume and storage implementation are TRD decisions. Operational changes must remain auditable even when browser telemetry is unavailable.

## 15. Page and navigation inventory

Pages are user surfaces, not a mandate for one route or table per item. Shared pages adapt controls/data to the selected role.

| Area | Required surfaces |
|---|---|
| Access | Sign in; role/school chooser; child chooser; account/password/recovery |
| Dashboards | Operator overview; Admin operations; Accountant fees; Principal academics; Owner management; Teacher today; Parent/Student overview |
| Setup | School information; timings/periods; academic years; student calendar; staff/group calendars; classes; sections; subjects; teaching/class-teacher assignments |
| Students | Directory/search; student profile with role-appropriate tabs; admission/edit; guardian links; placement/shuffle |
| Imports | Template/upload/mapping; validation preview; confirmation/result |
| Admissions | Lead pipeline/list; lead detail/contact history; next-follow-up view; conversion form |
| Timetable | Weekly grid; actual date view; affected lessons/free teachers/substitute assignment |
| Attendance | Day marking; period marking; submission/history/correction; summaries |
| Diary | Entry/editor; lesson/date/teacher/section history |
| Homework | Assignments; class checking roster; student progress/detail |
| Fees configuration | Heads; collection bank accounts; terms; structures; concessions/adjustments; fixed late-charge rules |
| Fees operations | Invoice generation/preview; student statement; cash/QR collection; cheque register; receipt print/download; correction/reversal |
| Fees reports | Daily collections; dues; breakdown/trends; concessions/waivers and cheque exceptions |
| Staff | Groups; directory/profile; staff attendance; salary/bank record; monthly calculator/history/export |
| User management | School users/memberships; create/link/reset/disable; account details |
| Operator | Organizations/schools; platform users; authentication/session history; activity/change/access logs; usage summary |

No clickable empty module pretending to work. Exams may have a deliberate future placeholder but must not offer nonfunctional actions. Do not reproduce old VidyaOS sidebar modules as launch promises.

## 16. Dashboard and reporting behavior

Admin: current school/year, attendance marking coverage, absent teachers/affected lessons, pending diary/homework checks, leads due for follow-up, dues/collections and setup issues.

Teacher: own teaching sessions/substitutions, attendance tasks, diary entries and homework checks. Parent/Student: selected child/own schedule, attendance marking status, relevant diary/homework and fee dues/receipts.

Principal: student/teacher attendance, teacher lesson records and homework checking coverage. Owner: organization/school fee totals, staff calculation totals and attendance summaries. Accountant: today/date-range collections, dues, concession totals, cheque status and reversals. Operator: organizations/users and available usage/authentication/business events.

Report date/year/school filters are explicit. Missing work and missing data are distinct. Counts use the same scope/rules as the detail page. Confidential data must not leak through a summary/export.

## 17. Product quality requirements

- Usable responsive web interface for office desktops and teacher/parent phones; native apps deferred.
- Plain labels, visible school/year/role/child context, clear saved/unsaved feedback.
- Bulk attendance/homework checking and efficient search; no forced profile-by-profile marking.
- Lists load in manageable batches with filters; avoid fetching full sensitive histories by default.
- Correct loading/empty/error/permission states; an unavailable network must not look like successful save or zero dues.
- Prevent duplicate submission of financially or operationally consequential actions; safe retries and meaningful partial-failure results.
- Private operational-record access, auditable changes and school/child/assignment isolation.
- Keyboard-accessible controls and readable contrast; color is not the only indicator.
- Original printable/downloadable receipts and practical export formats.
- On-demand exports of authorized datasets, including a complete school operational-data export for Admin/Operator. Preserve identifiers and relationships across datasets. Salary/bank exports remain confidential and raw audit/activity exports remain Operator-only. Do not export passwords, session tokens or infrastructure secrets. This is an export feature, not a tested backup/restore system.
- Reliability matters more than a large number of visual dashboard tiles. Detailed performance targets and monitoring belong in TRD.

## 18. Release acceptance scenarios

| ID | Scenario | Required result |
|---|---|---|
| AC-01 | Two unrelated schools use the portal | No cross-school student/fee/staff/document access through pages, direct record links or exports |
| AC-02 | Teacher is also Parent | One account; context chooser; Parent view cannot expose teacher permissions to another child |
| AC-03 | Parent has two children | Correct child cards/switching; unrelated children unavailable |
| AC-04 | Owner/Principal/Accountant open restricted areas | Owner no diary/homework; Principal/Accountant no salary/bank data; all denied raw logs |
| AC-05 | Operator opens/changes a school record | Access works; actual Operator identity retained in logs |
| AC-06 | Academic year changes | Old attendance and unpaid obligations still available; no automatic promotion |
| AC-07 | Staff work on a student holiday | Staff attendance/pay eligibility follows staff calendar; student lessons follow student calendar |
| AC-08 | Spreadsheet has errors/duplicates | Preview identifies them; draft rows fix/remove; repeated import does not duplicate debts/people |
| AC-09 | Convert a lead twice | One connected student/admission; contact history retained |
| AC-10 | Mid-year student joins | Standard class fees; no automatic prorating; attendance starts on joining date |
| AC-11 | Student/batch changes section | Effective placement and roll checks; old attendance/homework history retained |
| AC-12 | Subject occurs twice in one day | Separate sessions, diary and period attendance |
| AC-13 | Teacher absent | Affected lessons flagged; suggestions show conflicts; Admin assigns/replaces substitute |
| AC-14 | Day attendance has present/half-day/absent | Scores 1/0.5/0; unmarked separately; appropriate eligibility denominator |
| AC-15 | Period attendance incomplete/cancelled | No final misleading percentage; cancelled periods excluded |
| AC-16 | Teacher records yesterday's diary/check today | Lesson/check observation and entry times remain distinct |
| AC-17 | Subject teacher checks homework | Applicable student roster; per-student ticks/corrections; Principal and linked parent see results |
| AC-18 | Teacher has not checked homework | Unchecked, not automatically Not completed |
| AC-19 | Partial QR/cash payment | Verified posted allocation; remaining balance correct; original receipt printable |
| AC-20 | Duplicate collection submission | No duplicate posted collection/receipt |
| AC-21 | Cheque pending then clears/bounces | Pending excluded from settled totals; valid posted/reversal result and history |
| AC-22 | Accountant grants concession/reverses error | Direct action, no approval queue; bounds checked; original transaction preserved |
| AC-23 | Pricing changes after invoice/receipt | Original document unchanged; future pricing/explicit adjustments separate |
| AC-24 | Re-evaluate fixed late fee | No duplicate charge; recorded waiver visible |
| AC-25 | Collection exceeds dues | No silent credit wallet or excess allocation; exception visible |
| AC-26 | Salary 40000, W20, present15, paid leave1 | 32000; no holiday/paid-leave double counting; confidential output |
| AC-27 | Salary/calendar later changes | Saved calculation retained; deliberate corrected version available |
| AC-28 | User closes tab without logout | Last-seen/estimate shown; exact logout not fabricated |
| AC-29 | Account reset/disable | Correct scope, recoverable user flow and logs; unrelated-school membership preserved |
| AC-30 | Export school operational data | Authorized datasets export with identifiers, relationships and counts; confidential fields and Operator-only logs retain their access boundaries |

## 19. Delivery dependencies and next documents

Before implementing reporting fields: verify current official Telangana/UDISE+ student template and field dictionary. Before live imports: obtain anonymized/sample spreadsheet formats and decide explicit mappings. Before school rollout: confirm school-specific calendars, fee structures/concession/late-charge settings, account provisioning and opening-balance totals.

These are implementation inputs inside the agreed scope, not additional modules. Architecture, exact permission enforcement, audit storage/retention, Supabase configuration, hosting, database constraints, file handling, parallel-agent ownership and integration checks will be specified in the TRD/database/app-flow/UI documents.

No claim is made that the old schema/screens prove correct behavior, that every possible ERP edge case is solved, or that a time-boxed build is ready without validation. The agreed scope is sufficient to move into technical design without another broad module-discovery round.

## 20. Source and decision basis

Primary authority: founder's direct instructions in this conversation, including the latest confirmations on equal mid-year fees, 1/0.5/0 attendance, manual website-source leads, and teacher classroom homework checking with later entry.

Earlier materials: SIS and fee deep dives; scoping document; old VidyaOS schema; progressively expanded PrimeCampus database drafts; eleven supplied setup/timetable screenshots. These explain intent but do not override the later scope cuts/role boundaries.

Current planning predecessor: PRIMECAMPUS-V1-MASTER-SCOPE.md. This PRD is now the authoritative product baseline. Current Supabase references verified during planning: https://supabase.com/docs/guides/auth/passwords and https://supabase.com/docs/guides/auth/audit-logs. They support the selected authentication direction; concrete technical design is deferred to TRD.
