import datetime as dt
import importlib.util
import pathlib
import sqlite3
import unittest

SCRIPT=pathlib.Path(__file__).resolve().parent.parent/"scripts"/"p5_trends_to_d1.py"
spec=importlib.util.spec_from_file_location("p5_trends_to_d1",SCRIPT)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def sample(now):
    stamp=(now-dt.timedelta(minutes=3)).strftime("%a, %d %b %Y %H:%M:%S %z")
    return ('<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss"><channel>'
      '<item><title>周杰倫新歌</title><pubDate>'+stamp+'</pubDate><ht:approx_traffic>20K+</ht:approx_traffic></item>'
      '<item><title>霹靂布袋戲熱門話題</title><pubDate>'+stamp+'</pubDate><ht:approx_traffic>10K+</ht:approx_traffic></item>'
      '</channel></rss>').encode()

class P5GoogleFallbackTest(unittest.TestCase):
    def setUp(self):
        self.now=dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        self.conn=sqlite3.connect(":memory:")
        self.conn.executescript("""
        CREATE TABLE p5_search_trends (
          trend_id TEXT PRIMARY KEY,keyword TEXT,region TEXT,source_url TEXT,
          first_seen_at TEXT,last_seen_at TEXT,published_at TEXT,traffic_label TEXT,
          traffic_lower_bound INTEGER,category_hint TEXT,moderation TEXT,status TEXT
        );
        CREATE TABLE p5_trend_radar_runs (
          slot TEXT PRIMARY KEY,status TEXT,scanned INTEGER,newly_detected INTEGER,
          error TEXT,started_at TEXT,finished_at TEXT
        );
        """)
    def tearDown(self): self.conn.close()
    def test_d1_sql_is_idempotent_and_never_publishes(self):
        sql,count=m.generate_sql(sample(self.now),self.now)
        self.assertEqual(count,2)
        self.assertNotIn("social_actions",sql)
        self.assertNotIn("threads_publish",sql)
        self.assertNotIn("BEGIN TRANSACTION",sql)
        self.conn.executescript(sql)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM p5_search_trends").fetchone()[0],2)
        self.conn.executescript(sql)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM p5_search_trends").fetchone()[0],2)
        self.assertEqual(self.conn.execute("SELECT scanned FROM p5_trend_radar_runs").fetchone()[0],2)
    def test_title_apostrophes_are_sql_escaped(self):
        b=sample(self.now).replace("周杰倫新歌".encode(),b"O'Reilly".replace(b"&",b"&amp;"))
        sql,count=m.generate_sql(b,self.now)
        self.assertEqual(count,2)
        self.conn.executescript(sql)
        self.assertIn("O'Reilly",[x[0] for x in self.conn.execute("SELECT keyword FROM p5_search_trends")])
    def test_old_searches_not_included(self):
        old=(self.now-dt.timedelta(days=5)).strftime("%a, %d %b %Y %H:%M:%S %z")
        self.assertEqual(m.parse_rss(('<rss><channel><item><title>過期的舊聞</title><pubDate>'+old+'</pubDate></item></channel></rss>').encode(),self.now),[])
    def test_google_volume_is_not_threads_view_count(self):
        self.assertEqual(m.lower_bound("50K+"),50000)
        self.assertEqual(m.lower_bound("2萬+"),20000)
        self.assertEqual(m.lower_bound("1.2M+"),1200000)
        self.assertEqual(m.lower_bound("no data"),0)

if __name__=="__main__":
    unittest.main()
