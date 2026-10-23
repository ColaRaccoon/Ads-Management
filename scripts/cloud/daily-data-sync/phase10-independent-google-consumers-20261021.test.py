import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('consumer', pathlib.Path(__file__).with_name('phase10-independent-google-consumers-20261021.py'))
consumer=importlib.util.module_from_spec(spec);spec.loader.exec_module(consumer)
EXPECTED={'type':'authorized_user','client_id':'synthetic-client-1343','client_secret':'synthetic-secret-1343','refresh_token':'synthetic-refresh-1343'}

class ConsumerTests(unittest.TestCase):
    def test_source_tuple_requires_all_fields(self):
        self.assertTrue(consumer.match_source(EXPECTED,EXPECTED))
        self.assertFalse(consumer.match_source(dict(EXPECTED,refresh_token='different'),EXPECTED))
        self.assertFalse(consumer.match_source({'type':'service_account',**{k:v for k,v in EXPECTED.items() if k!='type'}},EXPECTED))
    def test_known_sqlite_ro_account_binding_no_access_claim(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d,'credentials.db');c=sqlite3.connect(p)
            c.execute('CREATE TABLE credentials(account_id TEXT,value TEXT)')
            c.execute('INSERT INTO credentials VALUES (?,?)',('synthetic-account@example.invalid',json.dumps(EXPECTED)))
            c.commit();c.close();before=p.read_bytes()
            got=consumer.inspect_database(p,EXPECTED)
            self.assertEqual(got['matchingCredentialRows'],1)
            self.assertEqual(got['matchingAccountIdentityHashes'],[consumer.digest('synthetic-account@example.invalid')])
            self.assertFalse(got['cachedAccessSameCredentialBindingProven'])
            self.assertEqual(p.read_bytes(),before)
            self.assertNotIn('synthetic-account',json.dumps(got))
    def test_bounded_scan_projects_no_paths_or_literals(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d);(p/'application_default_credentials.json').write_text(json.dumps(EXPECTED))
            (p/'old.dpapi').write_bytes(b'ENCRYPTED_SYNTHETIC')
            (p/'node_modules').mkdir();(p/'node_modules'/'secret.json').write_text(json.dumps(EXPECTED))
            got=consumer.inventory({'expected':EXPECTED,'capsule':'synthetic-capsule-1343','gcloud':d,'roots':[{'label':'GCLOUD','path':d}]})
            self.assertEqual(got['counters']['filesRead'],1);self.assertEqual(len(got['matches']),1)
            self.assertTrue(got['matches'][0]['executionConsumerProven'])
            self.assertEqual(got['counters']['encryptedProtectedSkipped'],1)
            wire=json.dumps(got)
            self.assertNotIn(d,wire)
            for k in ('client_id','client_secret','refresh_token'):self.assertNotIn(EXPECTED[k],wire)
    def test_unknown_database_not_read_as_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d,'access_tokens.db');c=sqlite3.connect(p)
            c.execute('CREATE TABLE access_tokens(account_id TEXT,access_token TEXT)');c.commit();c.close()
            got=consumer.inspect_database(p,EXPECTED)
            self.assertFalse(got['cachedUnexpiredAccessEligible']);self.assertEqual(got['matchingCredentialRows'],0)
    def test_capsule_only_hit_is_not_live_consumer(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d);(p/'reference.json').write_text(json.dumps({'stored':'synthetic-capsule-1343'}))
            got=consumer.inventory({'expected':EXPECTED,'capsule':'synthetic-capsule-1343','gcloud':d,'roots':[{'label':'EVIDENCE','path':d}]})
            self.assertTrue(got['matches'][0]['exactCapsuleLiteralMatch'])
            self.assertFalse(got['matches'][0]['executionConsumerProven'])

if __name__=='__main__':unittest.main()
