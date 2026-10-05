"""
PrimeCampus V1 — database acceptance scenarios (PRD §18 AC-01..AC-30 subset).

Runs against the local Postgres built by supabase/tests/run_all.sh. Every RPC is called as
the Supabase `authenticated` role with JWT claims (sub + session_id), so RLS,
grants and context checks are exercised exactly as PostgREST would.

    python3 supabase/tests/test_scenarios.py
"""
import json, uuid, sys, traceback
import psycopg2, psycopg2.extras

DSN = "host=/tmp port=5433 user=postgres dbname=pc_test"
conn = psycopg2.connect(DSN)
conn.autocommit = True
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
psycopg2.extras.register_uuid()

PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS " if cond else "  FAIL ") + name + ("" if cond else f"  -> {detail}"))

def su(sql, args=None):
    """Run as postgres (setup only)."""
    cur.execute("reset role")
    cur.execute("select set_config('request.jwt.claims', '', false)")
    cur.execute(sql, args)
    try:
        return cur.fetchall()
    except psycopg2.ProgrammingError:
        return None

class Actor:
    def __init__(self, uid, label):
        self.uid, self.label, self.sid, self.rev = uid, label, None, None
    def login(self):
        self.sid = uuid.uuid4()
        return self.call("bootstrap_account", "desktop", "pytest")
    def act(self):
        cur.execute("reset role")
        cur.execute("select set_config('request.jwt.claims', %s, false)",
                    (json.dumps({"sub": str(self.uid), "session_id": str(self.sid), "role": "authenticated"}),))
        cur.execute("set role authenticated")
    def call(self, fn, *args):
        self.act()
        ph = ",".join(["%s"] * len(args))
        cur.execute(f"select public.{fn}({ph}) as r", [json.dumps(a) if isinstance(a, (dict, list)) else a for a in args])
        return cur.fetchone()["r"]
    def rpc(self, fn, *args):
        """Context-scoped RPC: prepends the current context revision."""
        return self.call(fn, self.rev, *args)
    def err(self, fn, *args, scoped=True):
        try:
            (self.rpc if scoped else self.call)(fn, *args)
            return None
        except psycopg2.Error as e:
            return (e.diag.message_hint or e.pgcode or "ERR", e.diag.message_primary)
    def select(self, sql, args=None):
        self.act()
        cur.execute(sql, args)
        return cur.fetchall()
    def choose(self, role, school_id, student_id=None):
        boot = self.login()
        m = [c for c in boot["contexts"] if c["role"] == role and c["school_id"] == str(school_id)]
        assert m, f"{self.label}: no {role} context in {boot}"
        r = self.call("select_context", m[0]["membership_id"], str(student_id) if student_id else None, None)
        self.rev = r["context_revision"]
        return r
    def choose_operator(self, school_id):
        self.login()
        r = self.call("select_context", None, None, str(school_id))
        self.rev = r["context_revision"]
        return r

def make_user(username, display):
    uid = uuid.uuid4()
    su("insert into auth.users (id, email) values (%s, %s)", (uid, f"{username}@login.primecampus.test"))
    su("insert into app.accounts (id, username, display_name, status, must_change_password) values (%s,%s,%s,'active',false)",
       (uid, username, display))
    return uid

def op():
    return str(uuid.uuid4())

# =============================================================================
print("\n== Seed platform, two schools, people")
operator = make_user("op.vipul", "Operator")
su("insert into private.platform_operators (account_id) values (%s)", (operator,))
org = su("insert into app.organizations (name, code) values ('Preetham Schools','preetham') returning id")[0]["id"]
orgB = su("insert into app.organizations (name, code) values ('Other Trust','other') returning id")[0]["id"]
A = su("insert into app.schools (organization_id, name, code) values (%s,'Prime School A','psa') returning id", (org,))[0]["id"]
B = su("insert into app.schools (organization_id, name, code) values (%s,'Other School B','osb') returning id", (orgB,))[0]["id"]

u = {k: make_user(f"psa.{k}", k.title()) for k in
     ["admin", "teacher1", "teacher2", "accountant", "principal", "owner", "parent", "newbie"]}
u["adminB"] = make_user("osb.admin", "Admin B")
def member(uid, school, role, duty=False):
    su("insert into app.memberships (account_id, school_id, role, admissions_duty) values (%s,%s,%s,%s)", (uid, school, role, duty))
for k, role in [("admin","admin"),("teacher1","teacher"),("teacher2","teacher"),("accountant","accountant"),
                ("principal","principal"),("owner","owner"),("parent","parent"),("newbie","teacher")]:
    member(u[k], A, role)
member(u["teacher1"], A, "parent")          # AC-02: teacher who is also a parent
member(u["adminB"], B, "admin")
su("update app.accounts set must_change_password = true where id = %s", (u["newbie"],))

admin = Actor(u["admin"], "admin"); admin.choose("admin", A)
ctx = admin.call("get_context")
check("get_context returns school + caps", ctx["role"] == "admin" and "fees.manage" in ctx["capabilities"], ctx)

# =============================================================================
print("\n== Setup (SETUP-01..05)")
y = admin.rpc("save_academic_year", "2026-27", "2026-06-01", "2027-04-30")["academic_year_id"]
admin.rpc("set_current_year", y)
cls2 = admin.rpc("save_class", "Class 2", 2)["class_id"]
secA = admin.rpc("save_section", y, cls2, "A")["section_id"]
secB = admin.rpc("save_section", y, cls2, "B")["section_id"]
soc = admin.rpc("save_subject", "Social Studies", "SOC")["subject_id"]
mat = admin.rpc("save_subject", "Mathematics", "MAT")["subject_id"]
dup = admin.err("save_subject", "Maths again", "mat")
check("duplicate subject code rejected (case-insensitive)", dup is not None, dup)
admin.rpc("save_class_subjects", y, cls2, [{"subject_id": soc}, {"subject_id": mat}])
slots = [
  {"ordinal":1,"label":"P1","kind":"period","start_time":"09:00","end_time":"09:40"},
  {"ordinal":2,"label":"P2","kind":"period","start_time":"09:40","end_time":"10:20"},
  {"ordinal":3,"label":"Break","kind":"break","start_time":"10:20","end_time":"10:35"},
  {"ordinal":4,"label":"P3","kind":"period","start_time":"10:35","end_time":"11:15"},
  {"ordinal":5,"label":"P4","kind":"period","start_time":"11:15","end_time":"11:55"}]
reg = admin.rpc("save_period_schedule", "Regular", "regular", "08:45", "15:30", "2026-06-01", slots)["period_schedule_id"]
half = admin.rpc("save_period_schedule", "Saturday half", "half_day", "08:45", "12:00", "2026-06-01", slots[:2])["period_schedule_id"]
bad = admin.err("save_period_schedule", "Overlap", "special", "08:00", "15:00", "2026-06-01",
                [{"ordinal":1,"label":"A","kind":"period","start_time":"09:00","end_time":"10:00"},
                 {"ordinal":2,"label":"B","kind":"period","start_time":"09:30","end_time":"10:30"}])
check("overlapping periods rejected", bad is not None, bad)
admin.rpc("save_calendar_pattern", y, "student",
          [{"weekday":d,"day_type":"working"} for d in range(1,6)] +
          [{"weekday":6,"day_type":"half_day","period_schedule_id":half},{"weekday":7,"day_type":"weekly_off"}])
admin.rpc("save_calendar_pattern", y, "staff",
          [{"weekday":d,"day_type":"working"} for d in range(1,7)] + [{"weekday":7,"day_type":"weekly_off"}])
# Student holiday on 2026-10-02 (Gandhi Jayanti) — staff still work (AC-07)
admin.rpc("save_calendar_range", y, "student", "2026-10-02", "2026-10-02", "holiday", None, None, "Gandhi Jayanti")
out = admin.err("save_calendar_range", y, "student", "2027-06-01", "2027-06-02", "holiday")
check("calendar date outside academic year rejected", out is not None, out)
# Day-wise attendance until 31 Aug, period-wise from 1 Sep (seeded directly: the RPC refuses past dates)
su("insert into app.attendance_modes (school_id, mode, effective_from) values (%s,'daily','2026-06-01'),(%s,'period','2026-09-01')", (A, A))
past = admin.err("set_attendance_mode", "daily", "2026-09-01")
check("attendance mode change cannot rewrite the past", past and past[0] == "VALIDATION_ERROR", past)

grp = admin.rpc("save_staff_group", "Teaching")["staff_group_id"]
office = admin.rpc("save_staff_group", "Office")["staff_group_id"]
t1 = admin.rpc("save_staff", {"employee_no":"E001","full_name":"Teacher One","staff_group_id":grp,"is_teaching":True,"joined_on":"2025-06-01"})["staff_id"]
t2 = admin.rpc("save_staff", {"employee_no":"E002","full_name":"Teacher Two","staff_group_id":grp,"is_teaching":True,"joined_on":"2025-06-01"})["staff_id"]
clerk = admin.rpc("save_staff", {"employee_no":"E003","full_name":"Office Clerk","staff_group_id":office,"joined_on":"2025-06-01"})["staff_id"]
su("update app.staff set account_id=%s where id=%s", (u["teacher1"], t1))
su("update app.staff set account_id=%s where id=%s", (u["teacher2"], t2))
admin.rpc("save_teaching_assignment", secA, t1, "class_teacher", "2026-06-01")
admin.rpc("save_teaching_assignment", secA, t1, "subject", "2026-06-01", soc)
admin.rpc("save_teaching_assignment", secA, t2, "subject", "2026-06-01", mat)
admin.rpc("save_teaching_assignment", secB, t2, "class_teacher", "2026-06-01")
two_ct = admin.err("save_teaching_assignment", secA, t2, "class_teacher", "2026-07-01")
check("only one class teacher per section at a time", two_ct is not None, two_ct)

entries = []
for d in range(1, 7):
    entries += [{"weekday":d,"slot_ordinal":1,"subject_id":soc,"staff_id":str(t1)},
                {"weekday":d,"slot_ordinal":2,"subject_id":mat,"staff_id":str(t2)},
                {"weekday":d,"slot_ordinal":4,"subject_id":soc,"staff_id":str(t1)},   # AC-12 same subject twice
                {"weekday":d,"slot_ordinal":5,"subject_id":mat,"staff_id":str(t2)}]
brk = admin.err("save_timetable_draft", secA, reg, "2026-06-01", [{"weekday":1,"slot_ordinal":3,"subject_id":soc}])
check("subjects cannot be placed on a break", brk is not None, brk)
tv = admin.rpc("save_timetable_draft", secA, reg, "2026-06-01", entries)
admin.rpc("activate_timetable", tv["timetable_version_id"])
# Section B: T2 at slot 1 on Monday collides with nothing; T1 at slot 1 would clash with 2A
tvb = admin.rpc("save_timetable_draft", secB, reg, "2026-06-01",
                [{"weekday":1,"slot_ordinal":1,"subject_id":soc,"staff_id":str(t1)}])
check("timetable draft reports teacher clash", len(tvb["conflicts"]) == 1, tvb)
clash = admin.err("activate_timetable", tvb["timetable_version_id"])
check("activation blocked while a teacher is double-booked", clash and clash[0] == "CONFLICT", clash)

# =============================================================================
print("\n== Admissions (ADM-01/02, AC-09)")
lead = admin.rpc("save_lead", {"parent_name":"Parent P","phone":"9000000001","child_name":"Child One","source":"website",
                               "interested_class_id":cls2,"next_follow_up_on":"2026-05-20"})
lead2 = admin.rpc("save_lead", {"parent_name":"Parent P","phone":"9000000001","child_name":"Child Two","source":"walk_in"})
check("same-phone enquiry suggested, not merged", len(lead2["possible_duplicates"]) == 1, lead2)
admin.rpc("record_lead_followup", lead["lead_id"], "phone", "visit_scheduled", "Coming Monday", "2026-05-25", "contacted")
stu = lambda no, name: {"admission_no":no,"full_name":name,"gender":"female","date_of_birth":"2019-04-02","admission_date":"2026-06-01"}
adm_op = op()
s1 = admin.rpc("admit_student", adm_op, stu("A001","Child One"),
               [{"full_name":"Parent P","phone":"9000000001","relationship":"mother","is_primary":True}],
               secA, "2026-06-01", "1", lead["lead_id"],
               {"aadhaar_number":"123412341234","social_category":"obc","is_cwsn":False})
again = admin.rpc("admit_student", op(), stu("A001X","Child One again"), [{"guardian_id": s1["guardian_ids"][0]}], secA, "2026-06-01", None, lead["lead_id"])
check("converting a lead twice returns the same student", again.get("replayed") and again["student_id"] == s1["student_id"], again)
replay = admin.rpc("admit_student", adm_op, stu("A001","Child One"),
                   [{"full_name":"Parent P","phone":"9000000001","relationship":"mother","is_primary":True}],
                   secA, "2026-06-01", "1", lead["lead_id"], {"aadhaar_number":"123412341234","social_category":"obc","is_cwsn":False})
check("lead row shows converted", su("select stage from app.leads where id=%s", (lead["lead_id"],))[0]["stage"] == "converted")
gP = s1["guardian_ids"][0]
s1 = s1["student_id"]
s2 = admin.rpc("admit_student", op(), stu("A002","Child Two"), [{"guardian_id":gP,"relationship":"mother"}], secB, "2026-06-01", "1", lead2["lead_id"])["student_id"]
s3 = admin.rpc("admit_student", op(), stu("A003","Teacher Kid"), [{"full_name":"Teacher One","phone":"9000000003","relationship":"father"}], secA, "2026-06-01", "2")["student_id"]
s4 = admin.rpc("admit_student", op(), stu("A004","Late Joiner"), [{"full_name":"Parent Q","phone":"9000000004"}], secA, "2026-09-15", "3")["student_id"]
su("update app.guardians set account_id=%s where id=%s", (u["parent"], gP))
su("update app.guardians set account_id=%s where id=(select guardian_id from app.student_guardians where student_id=%s)", (u["teacher1"], s3))
dup_adm = admin.err("admit_student", op(), stu("a001","Dup"), [{"full_name":"X"}], secA, "2026-06-01")
check("duplicate admission number rejected", dup_adm and dup_adm[0] == "DUPLICATE", dup_adm)
roll = admin.err("admit_student", op(), stu("A005","Roll Clash"), [{"full_name":"X"}], secA, "2026-06-01", "1")
check("roll number clash in a section rejected", roll is not None, roll)

# =============================================================================
print("\n== Lessons, substitution (TIME-01..03, AC-12, AC-13)")
gen = admin.rpc("generate_lesson_sessions", "2026-09-28", "2026-10-03", None)
again = admin.rpc("generate_lesson_sessions", "2026-09-28", "2026-10-03", None)
check("lesson generation is idempotent", again["created"] == 0 and gen["created"] > 0, (gen, again))
sess = su("select id, session_date, slot_ordinal, subject_id from app.lesson_sessions where section_id=%s order by session_date, slot_ordinal", (secA,))
days = sorted({str(r["session_date"]) for r in sess})
check("no lessons on student holiday 2 Oct", "2026-10-02" not in days, days)
sat = [r for r in sess if str(r["session_date"]) == "2026-10-03"]
check("Saturday half-day uses the half-day bell schedule (2 periods)", len(sat) == 2, sat)
mon = {r["slot_ordinal"]: r["id"] for r in sess if str(r["session_date"]) == "2026-09-28"}
check("same subject twice in a day = two distinct lessons", mon[1] != mon[4], mon)

# T1 absent on Tuesday 29 Sep; Admin assigns T2 to T1's P1
admin.rpc("mark_staff_attendance", op(), "2026-09-29", [{"staff_id":str(t1),"status":"A"},{"staff_id":str(t2),"status":"P"}])
tue = {r["slot_ordinal"]: r["id"] for r in sess if str(r["session_date"]) == "2026-09-29"}
sched = admin.rpc("get_date_schedule", "2026-09-29", secA, None)
check("absent planned teacher flagged on date view", any(x["planned_teacher_absent"] for x in sched if x["slot_ordinal"] == 1), sched[:1])
sugg = admin.rpc("suggest_substitutes", tue[1])
t2s = [x for x in sugg if x["staff_id"] == str(t2)][0]
check("T2 suggested: present, no conflict at P1", t2s["availability"] == "present" and not t2s["has_conflict"], sugg)
c2 = admin.err("assign_substitute", tue[2], t1)
check("assigning an absent/overlapping teacher needs a reason", c2 and c2[0] in ("CONFLICT","VALIDATION_ERROR"), c2)
admin.rpc("assign_substitute", tue[1], t2, "T1 on leave")

# =============================================================================
print("\n== Period attendance + context isolation (ATT-01..03, AC-02, AC-15)")
teacher1 = Actor(u["teacher1"], "teacher1"); teacher1.choose("teacher", A)
teacher2 = Actor(u["teacher2"], "teacher2"); teacher2.choose("teacher", A)
roster = teacher1.rpc("get_marking_roster", "period", None, None, mon[1])
names = {s["name"] for s in roster["students"]}
check("roster excludes student who joined later (joined 15 Sep counts) & other section",
      names == {"Child One", "Teacher Kid", "Late Joiner"}, names)
forbidden = teacher2.err("mark_student_attendance", op(), "period", [{"student_id":str(s1),"status":"P"}], None, None, mon[1])
check("teacher cannot mark another teacher's lesson", forbidden and forbidden[0] == "FORBIDDEN", forbidden)
r1 = teacher1.rpc("mark_student_attendance", op(), "period", [{"student_id":str(s1),"status":"P"},{"student_id":str(s3),"status":"A"}], None, None, mon[1])
r2 = teacher2.rpc("mark_student_attendance", op(), "period", [{"student_id":str(s1),"status":"L"}], None, None, mon[2])
both = su("select count(*) n from app.student_period_attendance where student_id=%s and attendance_date='2026-09-28'", (s1,))[0]["n"]
check("different slots by different teachers both persist", both == 2, both)
check("partial save reports remaining unmarked", r1["unmarked_remaining"] == 1, r1)
stale = teacher1.rpc("mark_student_attendance", op(), "period", [{"student_id":str(s1),"status":"A"}], None, None, mon[1])
check("same-slot change without current version comes back as conflict", len(stale["conflicts"]) == 1 and stale["changed"] == 0, stale)
fixed = teacher1.rpc("mark_student_attendance", op(), "period", [{"student_id":str(s1),"status":"A","expected_version":1}], None, None, mon[1])
check("correction with right version applies + is logged", fixed["changed"] == 1 and
      su("select count(*) n from app.attendance_changes where person_id=%s", (s1,))[0]["n"] == 1, fixed)
o = op(); payload = [{"student_id":str(s4),"status":"P"}]
first = teacher1.rpc("mark_student_attendance", o, "period", payload, None, None, mon[1])
rep = teacher1.rpc("mark_student_attendance", o, "period", payload, None, None, mon[1])
check("replayed attendance submission returns original result", rep.get("replayed") and rep["marked"] == first["marked"], rep)
sub_ok = teacher2.rpc("mark_student_attendance", op(), "period", [{"student_id":str(s1),"status":"P"}], None, None, tue[1])
check("approved substitute can mark the covered lesson", sub_ok["marked"] == 1, sub_ok)
summ = admin.rpc("get_student_attendance_summary", s1, "2026-09-28", "2026-09-29")
check("incomplete period range is provisional, not final", summ["is_final"] is False and summ["unmarked_units"] > 0, summ)
before = summ["expected_units"]
admin.rpc("update_lesson_session", tue[4], "cancel", None, "Assembly ran long")
summ2 = admin.rpc("get_student_attendance_summary", s1, "2026-09-28", "2026-09-29")
check("cancelled lesson leaves the denominator", summ2["expected_units"] == before - 1, (before, summ2))

# Day-wise period (August): 1 / 0.5 / 0 scoring (AC-14)
teacher1.rpc("mark_student_attendance", op(), "daily", [{"student_id":str(s1),"status":"P"},{"student_id":str(s3),"status":"H"}], secA, "2026-08-03")
teacher1.rpc("mark_student_attendance", op(), "daily", [{"student_id":str(s1),"status":"H"},{"student_id":str(s3),"status":"A"}], secA, "2026-08-04")
d1 = admin.rpc("get_student_attendance_summary", s1, "2026-08-03", "2026-08-04")
check("daily scoring P + H = 1.5 of 2", float(d1["attended_units"]) == 1.5 and d1["expected_units"] == 2 and d1["is_final"], d1)
nd = teacher1.err("mark_student_attendance", op(), "daily", [{"student_id":str(s1),"status":"P"}], secA, "2026-08-02")
check("cannot mark a Sunday (weekly off)", nd and nd[0] == "VALIDATION_ERROR", nd)
pm = teacher1.err("mark_student_attendance", op(), "daily", [{"student_id":str(s1),"status":"P"}], secA, "2026-09-28")
check("daily marking refused once school is in period mode", pm and pm[0] == "VALIDATION_ERROR", pm)
late = admin.rpc("get_student_attendance_summary", s4, "2026-09-01", "2026-09-29")
check("attendance starts at joining date (mid-year joiner)", late["daily_units"] == 0 and late["period_units"] > 0, late)

# Teacher who is also a parent: switch to Parent context (AC-02)
tp = Actor(u["teacher1"], "teacher1-as-parent"); tp.sid = teacher1.sid      # same browser session
pctx = [c for c in tp.call("bootstrap_account", "desktop", "pytest")["contexts"] if c["role"] == "parent"][0]
pr = tp.call("select_context", pctx["membership_id"], str(s3), None)
stale_ctx = teacher1.err("get_marking_roster", "period", None, None, mon[1])
check("old teacher revision is rejected after switching (STALE_CONTEXT)", stale_ctx and stale_ctx[0] == "STALE_CONTEXT", stale_ctx)
tp.rev = pr["context_revision"]
as_parent = tp.err("get_marking_roster", "period", None, None, mon[1])
check("parent context cannot use teacher grants", as_parent and as_parent[0] == "FORBIDDEN", as_parent)
rows = tp.select("select id from app.students")
check("parent context sees only the selected child row", [str(r["id"]) for r in rows] == [str(s3)], rows)
teacher1.choose("teacher", A)

# =============================================================================
print("\n== Homework (HW-01..03, AC-16..18)")
hw = teacher1.rpc("save_homework", None, mon[1], "2026-09-30", "Map work: rivers of Telangana")
ros = teacher1.rpc("get_homework_roster", hw["assignment_id"])
check("homework roster lists the section's eligible students", len(ros["students"]) == 3, ros)
chk = teacher1.rpc("mark_homework_checks", op(), hw["assignment_id"], "2026-10-01",
                   [{"student_id":str(s1),"completion":"completed","completed_on":"2026-09-29"},
                    {"student_id":str(s4),"completion":"not_completed","correction":"required"}])
check("checks saved", chk["saved"] == 2, chk)
entered = su("select observed_on, entered_at::date as e from app.homework_checks where student_id=%s", (s1,))[0]
check("observation date distinct from entry date (delayed entry)", str(entered["observed_on"]) == "2026-10-01" and str(entered["e"]) == "2026-10-05", entered)
ros2 = teacher1.rpc("get_homework_roster", hw["assignment_id"])
s3state = [s for s in ros2["students"] if s["student_id"] == str(s3)][0]["state"]
check("unchecked student stays 'unchecked' (not 'not_completed')", s3state == "unchecked", s3state)
not_mine = teacher2.err("mark_homework_checks", op(), hw["assignment_id"], "2026-10-01", [{"student_id":str(s1),"completion":"completed"}])
check("maths teacher cannot check social homework", not_mine and not_mine[0] == "FORBIDDEN", not_mine)
teacher1.rpc("save_diary_entry", mon[1], "Rivers and dams; Godavari basin")
d_again = teacher1.err("save_diary_entry", mon[1], "overwrite blindly")
check("diary update requires the current version", d_again and d_again[0] == "CONFLICT", d_again)

parent = Actor(u["parent"], "parent"); parent.choose("parent", A, s1)
ph = parent.rpc("get_student_homework", s1, "2026-09-01", "2026-10-31")
check("parent sees child's homework with teacher check", len(ph) == 1 and ph[0]["state"] == "completed", ph)
ps2 = parent.err("get_student_homework", s2, "2026-09-01", "2026-10-31")
check("parent cannot read the other (unselected) child", ps2 and ps2[0] == "FORBIDDEN", ps2)
diary_rows = parent.select("select body from app.diary_entries")
check("parent sees diary of child's section", len(diary_rows) == 1, diary_rows)

owner = Actor(u["owner"], "owner"); owner.choose("owner", A)
oh = owner.err("get_student_homework", s1, "2026-09-01", "2026-10-31")
check("Owner cannot open homework detail (AC-04)", oh and oh[0] == "FORBIDDEN", oh)
check("Owner sees no diary rows (AC-04)", owner.select("select count(*) n from app.diary_entries")[0]["n"] == 0)
check("Owner sees no raw attendance rows", owner.select("select count(*) n from app.student_period_attendance")[0]["n"] == 0)
ov = owner.rpc("get_attendance_overview", "2026-09-28")
check("Owner gets attendance summary instead", ov["mode"] == "period" and len(ov["sections"]) == 2, ov)

# =============================================================================
print("\n== Fees (FEE-01..06, AC-19..25)")
acct = Actor(u["accountant"], "accountant"); acct.choose("accountant", A)
tui = acct.rpc("save_fee_head", "Tuition", "TUI")["fee_head_id"]
trn = acct.rpc("save_fee_head", "Transport", "TRN", "regular", True)["fee_head_id"]
lfh = acct.rpc("save_fee_head", "Late fee", "LATE", "late_fee")["fee_head_id"]
obh = acct.rpc("save_fee_head", "Opening balance", "OPEN", "other")["fee_head_id"]
cash = acct.rpc("save_receiving_account", {"label":"Front desk","kind":"cash_desk"})["receiving_account_id"]
bank = acct.rpc("save_receiving_account", {"label":"SBI current","kind":"bank","bank_name":"SBI","account_last4":"4321","ifsc":"SBIN0001234"})["receiving_account_id"]
term1 = acct.rpc("save_fee_term", y, "Term 1", 1, "2026-07-15")["fee_term_id"]
acct.rpc("save_fee_structure", term1, cls2, [{"fee_head_id":tui,"amount_paise":1000000},{"fee_head_id":trn,"amount_paise":300000}])
sib = acct.rpc("save_concession_preset", "Sibling 10%", "percent", "{%s}" % tui, 1000)["concession_preset_id"]
acct.rpc("grant_concession", s2, y, sib, "Second child")
acct.rpc("set_optional_fee", s1, y, trn, True)
prev = acct.rpc("preview_term_invoices", term1, None, None)
p1 = [p for p in prev if p["student_id"] == str(s1)][0]
p2 = [p for p in prev if p["student_id"] == str(s2)][0]
check("preview: optional transport only for opted student", p1["net_paise"] == 1300000 and p2["gross_paise"] == 1000000, (p1, p2))
check("preview: 10% concession = ₹1,000 on tuition", p2["concession_paise"] == 100000 and p2["net_paise"] == 900000, p2)
iss_op = op()
iss = acct.rpc("issue_term_invoices", iss_op, term1, None, None)
iss2 = acct.rpc("issue_term_invoices", op(), term1, None, None)
check("issuing twice never double-charges", iss["issued"] == 4 and iss2["issued"] == 0 and iss2["already_existing"] == 4, (iss, iss2))
lj = [p for p in prev if p["student_id"] == str(s4)][0]
check("mid-year joiner pays the same standard fee (no proration)", lj["net_paise"] == 1000000, lj)
inv1 = su("select id from app.invoices where student_id=%s", (s1,))[0]["id"]
inv2 = su("select id from app.invoices where student_id=%s", (s2,))[0]["id"]

acct.rpc("save_fee_structure", term1, cls2, [{"fee_head_id":tui,"amount_paise":1200000},{"fee_head_id":trn,"amount_paise":300000}])
st = acct.rpc("get_student_statement", s1)
check("price change after issue leaves issued invoice unchanged (AC-23)", st["invoices"][0]["charged_paise"] == 1300000, st["invoices"][0])

pop = op()
col = acct.rpc("post_collection", pop, s1, "cash", 400000, "2026-07-10", [{"invoice_id":str(inv1),"amount_paise":400000}])
rep = acct.rpc("post_collection", pop, s1, "cash", 400000, "2026-07-10", [{"invoice_id":str(inv1),"amount_paise":400000}])
check("partial cash payment posts with a receipt", col["receipt_no"].startswith("RCT/2026-27/00001"), col)
check("double-submit returns the same receipt (AC-20)", rep.get("replayed") and rep["receipt_no"] == col["receipt_no"], rep)
diff = acct.err("post_collection", pop, s1, "cash", 500000, "2026-07-10", [{"invoice_id":str(inv1),"amount_paise":500000}])
check("same operation id with different content is refused", diff and diff[0] == "DUPLICATE", diff)
st = acct.rpc("get_student_statement", s1)
check("remaining balance correct after partial payment (AC-19)", st["total_due_paise"] == 900000 and st["invoices"][0]["payment_state"] == "partial", st["invoices"][0])
over = acct.err("post_collection", op(), s1, "cash", 1000000, "2026-07-11", [{"invoice_id":str(inv1),"amount_paise":1000000}])
check("allocation above dues rejected; no credit wallet (AC-25)", over and over[0] == "VALIDATION_ERROR", over)
cross = acct.err("post_collection", op(), s1, "cash", 1000, "2026-07-11", [{"invoice_id":str(inv2),"amount_paise":1000}])
check("cannot allocate to a sibling's invoice", cross and cross[0] == "VALIDATION_ERROR", cross)
upi = acct.rpc("post_collection", op(), s1, "upi", 100000, "2026-07-12", [{"invoice_id":str(inv1),"amount_paise":100000}], bank, "UTR 6123-4567-89")
dupref = acct.err("post_collection", op(), s1, "upi", 100000, "2026-07-12", [{"invoice_id":str(inv1),"amount_paise":100000}], bank, "utr612345678 9")
check("same UPI reference (normalised) cannot post twice", dupref and dupref[0] == "DUPLICATE", dupref)

acct.rpc("save_late_fee_rule", y, lfh, 10000, 5)
lf = acct.rpc("evaluate_late_fees", "2026-08-01")
lf2 = acct.rpc("evaluate_late_fees", "2026-08-01")
check("fixed late fee applied once; re-run adds nothing (AC-24)", lf["late_fees_added"] >= 1 and lf2["late_fees_added"] == 0, (lf, lf2))
acct.rpc("waive_late_fee", inv1, "First delay, parent request")
st = acct.rpc("get_student_statement", s1)
kinds = [a["kind"] for a in st["invoices"][0]["adjustments"]]
check("waiver recorded and visible next to the late fee", kinds == ["late_fee", "late_fee_waiver"] and st["total_due_paise"] == 800000, (kinds, st["total_due_paise"]))

chq = acct.rpc("record_cheque", op(), s2, "123456", "HDFC", "2026-07-14", 900000, bank, "2026-07-14", [{"invoice_id":str(inv2),"amount_paise":900000}])
st2 = acct.rpc("get_student_statement", s2)
check("pending cheque does not settle dues (AC-21)", st2["total_due_paise"] >= 900000 and len(st2["pending_cheques"]) == 1, st2["total_due_paise"])
lf3 = acct.rpc("evaluate_late_fees", "2026-08-01")
check("invoice with pending cheque is not late-fined", str(inv2) in lf3["skipped_pending_cheque"], lf3)
cl = acct.rpc("clear_cheque", chq["cheque_id"], "2026-07-18")
cl2 = acct.rpc("clear_cheque", chq["cheque_id"], "2026-07-18")
st2 = acct.rpc("get_student_statement", s2)
# ₹100 late fee was charged on 1 Aug before the cheque existed, so it remains due
check("cleared cheque posts once; repeat is a no-op", st2["total_due_paise"] == 10000 and cl2.get("replayed"), st2["total_due_paise"])
acct.rpc("bounce_cheque", chq["cheque_id"], "2026-07-20", "Insufficient funds")
st2 = acct.rpc("get_student_statement", s2)
check("bounce after clearing reopens dues via a linked reversal", st2["total_due_paise"] == 910000 and
      st2["collections"][0]["reversed_paise"] == 900000, st2["collections"])

rev = acct.rpc("reverse_collection", op(), upi["collection_id"], "Wrong student", 40000)
over_rev = acct.err("reverse_collection", op(), upi["collection_id"], "again", 70000)
check("partial reversal allowed; reversing more than remains refused (AC-22)", rev["still_reversible_paise"] == 60000 and over_rev, (rev, over_rev))
check("original collection row is untouched", su("select amount_paise from app.collections where id=%s", (upi["collection_id"],))[0]["amount_paise"] == 100000)
imm = None
try:
    su("update app.collections set amount_paise = 1 where id=%s", (upi["collection_id"],))
except psycopg2.Error as e:
    imm = e.diag.message_primary
check("posted collections are immutable even for the owner role", imm is not None, imm)
rc = parent.rpc("get_receipt", col["receipt_id"])
check("parent can reprint own child's receipt from the snapshot", rc["snapshot"]["amount_paise"] == 400000, rc)
rep_ = acct.rpc("get_collection_report", "2026-07-01", "2026-10-31")   # reversals dated when recorded
check("collection report: posted vs reversed separated", rep_["gross_posted_paise"] == 400000 + 100000 + 900000 and rep_["reversed_paise"] == 940000, rep_)
dues = acct.rpc("get_dues_report", y, None, None, False)
check("dues report reconciles with statements", sum(d["balance_paise"] for d in dues) ==
      sum(acct.rpc("get_student_statement", s)["total_due_paise"] for s in [s1, s2, s3, s4]), dues)
ob = acct.rpc("issue_opening_balance", s1, y, obh, 250000, "2025-26 arrears", "import:A001:2025", "2026-06-30")
ob2 = acct.rpc("issue_opening_balance", s1, y, obh, 250000, "2025-26 arrears", "import:A001:2025", "2026-06-30")
check("opening balance imported once with its origin (AC-08)", ob2.get("replayed") and ob2["invoice_id"] == ob["invoice_id"], ob2)

# =============================================================================
print("\n== Restricted areas (AC-04)")
principal = Actor(u["principal"], "principal"); principal.choose("principal", A)
acct_staff = acct.err("get_staff_confidential", t1)
check("Accountant cannot see salary/bank", acct_staff and acct_staff[0] == "FORBIDDEN", acct_staff)
check("Principal sees no bank rows", principal.select("select count(*) n from app.staff_bank_accounts")[0]["n"] == 0)
check("Principal sees no sensitive student rows", principal.select("select count(*) n from app.student_sensitive")[0]["n"] == 0)
pf = principal.err("post_collection", op(), s1, "cash", 100, "2026-07-10", [{"invoice_id":str(inv1),"amount_paise":100}])
check("Principal is read-only for fees", pf and pf[0] == "FORBIDDEN", pf)
pw = principal.err("save_class", "Class X", 9)
check("Principal cannot change setup", pw and pw[0] == "FORBIDDEN", pw)
check("Teacher sees no fee rows", teacher1.select("select count(*) n from app.invoices")[0]["n"] == 0)
for who in (admin, acct, principal, owner):
    e = who.err("op_get_audit_events", scoped=False)
    check(f"{who.label} denied raw logs", e and e[0] == "FORBIDDEN", e)
try:
    admin.select("select count(*) from private.audit_events")
    check("direct private table read blocked", False, "readable!")
except psycopg2.Error as e:
    check("direct private table read blocked", e.pgcode == "42501", e.pgcode)

# =============================================================================
print("\n== Salary calculator (SAL-01, AC-26, AC-27)")
admin.rpc("save_staff_finance", clerk, 4000000, "2025-06-01", "Joining salary", {"account_holder_name":"Office Clerk","account_number":"1234567890","ifsc":"sbin0001234","bank_name":"SBI"})
admin.rpc("save_calendar_pattern", y, "staff", [{"weekday":d,"day_type":"working"} for d in range(1,6)] +
          [{"weekday":6,"day_type":"weekly_off"},{"weekday":7,"day_type":"weekly_off"}], office)
admin.rpc("save_calendar_range", y, "staff", "2026-09-07", "2026-09-08", "holiday", office, None, "Office closed")
import datetime
wd = [datetime.date(2026,9,d) for d in range(1,31) if datetime.date(2026,9,d).weekday() < 5 and d not in (7,8)]
check("Office calendar has 20 working days in Sept", len(wd) == 20, len(wd))
for i, d in enumerate(wd):
    st_ = "P" if i < 15 else "A"
    if i == 15:
        continue        # paid leave day, left unmarked
    admin.rpc("mark_staff_attendance", op(), str(d), [{"staff_id":str(clerk),"status":st_}])
admin.rpc("record_paid_leave", clerk, str(wd[15]), 1.0, "Approved CL")
pv = admin.rpc("preview_salary", clerk, "2026-09-01", None)
check("₹40,000 × (15 + 1) / 20 = ₹32,000", pv["payable_paise"] == 3200000 and float(pv["unpaid_days"]) == 4, pv)
sv = admin.rpc("save_salary_calculation", clerk, "2026-09-01", None, None)
admin.rpc("save_staff_finance", clerk, 5000000, "2026-09-01", "Raise")
hist1 = owner.rpc("get_salary_calculations", "2026-09-01", clerk)
check("saved calculation unchanged after a later salary change", hist1[0]["payable_paise"] == 3200000, hist1)
sv2 = admin.rpc("save_salary_calculation", clerk, "2026-09-01", None, None)
hist2 = owner.rpc("get_salary_calculations", "2026-09-01", clerk)
check("corrected version supersedes but keeps v1", [h["status"] for h in hist2] == ["final","superseded"] and hist2[0]["payable_paise"] == 4000000, hist2)
zero = admin.err("save_salary_calculation", clerk, "2027-05-01", None, None)
check("zero working days needs manual resolution", zero and zero[0] in ("VALIDATION_ERROR",), zero)
ov_ = admin.err("save_salary_calculation", clerk, "2026-09-01", {"paid_leave_days": 30}, "typo")
check("paid days above working days refused", ov_ is not None, ov_)
ownb = owner.rpc("get_staff_confidential", clerk)
check("Owner reads salary/bank (AC-26 confidential to Admin/Owner)", ownb["bank"]["ifsc"] == "SBIN0001234", ownb)
t1_salary = teacher1.select("select count(*) n from app.salary_calculations")[0]["n"]
check("Teacher sees no salary calculations", t1_salary == 0, t1_salary)

# =============================================================================
print("\n== Placement move (SIS-02, AC-11)")
pv_mv = admin.rpc("move_placements", op(), "2026-10-01", "Section balancing", [{"student_id":str(s1),"section_id":str(secB),"roll_no":"1"}], True)
check("preview flags roll clash in destination", not pv_mv["can_apply"], pv_mv)
mv_op = op()
mv = admin.rpc("move_placements", mv_op, "2026-10-01", "Section balancing", [{"student_id":str(s1),"section_id":str(secB),"roll_no":"7"}], False)
check("move applied", mv["moved"] == 1, mv)
hist = su("select section_id, effective_from, effective_to from app.placements where student_id=%s order by effective_from", (s1,))
check("old placement closed, new one opened", str(hist[0]["effective_to"]) == "2026-10-01" and str(hist[1]["section_id"]) == str(secB), hist)
kept = su("select count(*) n from app.student_period_attendance where student_id=%s", (s1,))[0]["n"]
check("attendance history retained after move", kept >= 3, kept)
ph2 = parent.rpc("get_student_homework", s1, "2026-09-01", "2026-10-31")
check("old-section homework still visible after move", len(ph2) == 1, ph2)

# =============================================================================
print("\n== Tenancy isolation (AC-01)")
adminB = Actor(u["adminB"], "adminB"); adminB.choose("admin", B)
check("School B admin sees no School A students", adminB.select("select count(*) n from app.students")[0]["n"] == 0)
xs = adminB.err("get_student_statement", s1)
check("guessed foreign student id → not found", xs and xs[0] in ("NOT_FOUND","FORBIDDEN"), xs)
xc = adminB.err("post_collection", op(), s1, "cash", 100, "2026-07-10", [{"invoice_id":str(inv1),"amount_paise":100}])
check("cannot post money against another school's student", xc is not None, xc)
try:
    adminB.select("insert into app.classes (school_id, name, sort_order) values (%s, 'Hack', 1)", (A,))
    check("insert into foreign school blocked by RLS", False, "inserted!")
except psycopg2.Error as e:
    check("insert into foreign school blocked by RLS", e.pgcode == "42501", e.pgcode)
adminB.rpc("save_class", "B Class 1", 1)
try:
    adminB.select("update app.classes set school_id = %s where school_id = %s returning id", (A, B))
    check("cannot move own rows into another tenant", False, "moved!")
except psycopg2.Error as e:
    check("cannot move own rows into another tenant", e.pgcode == "42501", e.pgcode)
xm = adminB.err("disable_membership", su("select id from app.memberships where account_id=%s and role='teacher'", (u["teacher2"],))[0]["id"], "x")
check("cannot disable another school's membership", xm and xm[0] == "NOT_FOUND", xm)

# =============================================================================
print("\n== Operator, accounts, audit (AC-05, AC-28, AC-29)")
opx = Actor(operator, "operator"); opx.choose_operator(A)
opx.rpc("save_class", "Class 3", 3)
ev = opx.call("op_get_audit_events", str(A), None, "classes.insert", None, None, None, None, 5)
check("Operator change audited as Operator (true actor kept)", ev["items"][0]["actor_id"] == str(operator) and ev["items"][0]["via_operator"], ev["items"][:1])
fee_ev = opx.call("op_get_audit_events", str(A), None, "fees.collection.posted", None, None, None, None, 10)
check("fee postings are in the trusted audit", len(fee_ev["items"]) >= 3, len(fee_ev["items"]))
tm = admin.call("record_telemetry", [{"event":"page_view","path":"/fees"},{"event":"keystroke"}])
check("telemetry accepts whitelisted events only", tm["accepted"] == 1, tm)
big = admin.err("record_telemetry", [{"event":"page_view"}] * 21, scoped=False)
check("telemetry batch capped at 20", big and big[0] == "LIMIT_REACHED", big)
usage = opx.call("op_get_usage", "2026-10-01", "2026-10-31", str(A))
check("usage shows last-seen sessions without fabricated logout", any(s["ended"] is None for s in usage["sessions"]), usage["sessions"][:2])

newbie = Actor(u["newbie"], "newbie")
nb = newbie.login()
check("temporary-password account gets no contexts", nb["must_change_password"] and nb["contexts"] == [], nb)
nbctx = newbie.err("select_context", su("select id from app.memberships where account_id=%s", (u["newbie"],))[0]["id"], None, None, scoped=False)
check("temporary-password account cannot select a context", nbctx and nbctx[0] == "UNAUTHENTICATED", nbctx)

t1_teacher_mid = su("select id from app.memberships where account_id=%s and role='teacher'", (u["teacher1"],))[0]["id"]
admin.rpc("disable_membership", t1_teacher_mid, "Left teaching role")
dead = teacher1.err("get_marking_roster", "period", None, None, mon[1])
check("disabled membership stops the live session immediately", dead and dead[0] == "UNAUTHENTICATED", dead)
boot = Actor(u["teacher1"], "teacher1-again").login()
check("unrelated (parent) membership survives local disable", [c["role"] for c in boot["contexts"]] == ["parent"], boot["contexts"])
hist_author = su("select actor_id from app.attendance_submissions where actor_id=%s limit 1", (u["teacher1"],))
check("historical authorship preserved after disable", len(hist_author) == 1)

admin.call("end_app_session")
lo = admin.err("get_context", scoped=False)
check("logout ends the app session even if the JWT is still valid", lo and lo[0] == "UNAUTHENTICATED", lo)
admin.choose("admin", A)

# =============================================================================
print("\n== Academic year change (AC-06)")
y2 = admin.rpc("save_academic_year", "2027-28", "2027-06-01", "2028-04-30")["academic_year_id"]
admin.rpc("set_current_year", y2)
admin.rev = admin.call("get_context")["context_revision"]
st = acct.rpc("get_student_statement", s1)
check("old unpaid dues still visible after switching current year", st["total_due_paise"] > 0, st["total_due_paise"])
check("no automatic promotion into the new year", su("select count(*) n from app.enrollments where academic_year_id=%s", (y2,))[0]["n"] == 0)
d1b = admin.rpc("get_student_attendance_summary", s1, "2026-08-03", "2026-08-04")
check("old attendance not reinterpreted", float(d1b["attended_units"]) == 1.5, d1b)

# =============================================================================
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILED:", *FAIL, sep="\n  - ")
    sys.exit(1)
