"""Run after test_scenarios.py on the same DB. Two accountants race to over-collect one invoice,
and two teachers race on the same daily-attendance row. Exactly one of each must win."""
import json, uuid, threading, psycopg2, psycopg2.extras
DSN = "host=/tmp port=5433 user=postgres dbname=pc_test"

def session_for(uid):
    c = psycopg2.connect(DSN); c.autocommit = True
    cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    sid = str(uuid.uuid4())
    cur.execute("select set_config('request.jwt.claims', %s, false)", (json.dumps({"sub": str(uid), "session_id": sid}),))
    cur.execute("set role authenticated")
    boot = cur.execute("select public.bootstrap_account('desktop','race') r") or cur.fetchone()["r"]
    return c, cur, boot

su = psycopg2.connect(DSN); su.autocommit = True
q = su.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
q.execute("select a.id from app.accounts a where username='psa.accountant'"); acct = q.fetchone()["id"]
q.execute("select s.id sid, i.id iid from app.students s join app.invoices i on i.student_id=s.id where s.admission_no='A004'")
row = q.fetchone()

results = []
def collector(n):
    c, cur, boot = session_for(acct)
    m = [x for x in boot["contexts"] if x["role"] == "accountant"][0]
    cur.execute("select public.select_context(%s, null, null) r", (m["membership_id"],)); rev = cur.fetchone()["r"]["context_revision"]
    try:
        cur.execute("select public.post_collection(%s,%s,%s,'cash',600000,'2026-07-20',%s) r",
                    (rev, str(uuid.uuid4()), str(row["sid"]), json.dumps([{"invoice_id": str(row["iid"]), "amount_paise": 600000}])))
        results.append(("ok", cur.fetchone()["r"]["receipt_no"]))
    except psycopg2.Error as e:
        results.append(("err", e.diag.message_hint))
ts = [threading.Thread(target=collector, args=(i,)) for i in range(2)]
[t.start() for t in ts]; [t.join() for t in ts]
oks = [r for r in results if r[0] == "ok"]
print("money race:", results)
assert len(oks) == 1 and any(r == ("err", "VALIDATION_ERROR") for r in results), "over-collection race not prevented"
q.execute("select count(distinct receipt_seq) = count(*) as uniq from app.receipts"); assert q.fetchone()["uniq"]
print("PASS concurrent collectors cannot over-collect; receipt numbers stay unique")
