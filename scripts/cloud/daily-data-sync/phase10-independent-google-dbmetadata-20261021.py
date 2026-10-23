"""Only existing fixed gcloud config SQLite files. No auth, refresh, network or pickle."""
import hashlib, json, pathlib, re, sqlite3, sys

def sha(wire):return hashlib.sha256(wire).hexdigest()
def run(payload):
    expected={k:payload['expected'][k].encode() for k in ('client_id','client_secret','refresh_token')}
    root=pathlib.Path(payload['gcloud']);out=[]
    for name in ('default_configs.db','hidden_gcloud_config_universe_descriptor_data_cache_configs.db'):
        p=root/name
        row={'databaseClass':'DEFAULT_CONFIGS' if name=='default_configs.db' else 'UNIVERSE_DESCRIPTOR_CONFIG_CACHE','exists':p.exists(),'readonly':True,'matchingCredentialTupleRows':0,'rowsExamined':0,'identityBindingProven':False}
        if p.exists():
            for item in [p,*p.parents]:
                if item.is_symlink() or getattr(item.lstat(),'st_file_attributes',0)&0x400:raise ValueError('REPARSE')
            before=p.read_bytes()
            if len(before)>16777216:raise ValueError('DATABASE_BOUND')
            db=sqlite3.connect(p.resolve().as_uri()+'?mode=ro',uri=True,timeout=1)
            try:
                db.execute('PRAGMA query_only=ON')
                tables=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
                if len(tables)>20:raise ValueError('TABLE_BOUND')
                row['tableCount']=len(tables);row['schemaSha256']=sha(json.dumps(list(db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name')),default=str,separators=(',',':')).encode())
                for table in tables:
                    if not re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,79}',table):raise ValueError('TABLE_SHAPE')
                    records=list(db.execute('SELECT * FROM "'+table+'" LIMIT 101'))
                    if len(records)>100:raise ValueError('ROW_BOUND')
                    for record in records:
                        if len(record)>32:raise ValueError('COLUMN_BOUND')
                        row['rowsExamined']+=1;hits={k:False for k in expected}
                        for value in record:
                            if not isinstance(value,(str,bytes)):continue
                            wire=value.encode() if isinstance(value,str) else value
                            if len(wire)>65536:raise ValueError('VALUE_BOUND')
                            for k,needle in expected.items():hits[k] |= needle in wire
                        if all(hits.values()):row['matchingCredentialTupleRows']+=1
            finally:db.close()
            row['fileSha256']=sha(before);row['fileBytesUnchanged']=p.read_bytes()==before
            if not row['fileBytesUnchanged']:raise ValueError('CONCURRENT_CONFIG_WRITE')
        out.append(row)
    return {'kind':'GOOGLE_EXISTING_CONFIG_DATABASE_METADATA_READ','status':'PASS_BOUNDED_LOCAL_READ_ONLY','databases':out,'counters':{'filesRead':sum(int(x['exists']) for x in out),'bytesRead':0},'matches':[],'providerRequests':0,'oauthRefreshPosts':0,'sqliteWrites':0,'arbitraryPickleDeserialization':False,'rawIdentityOrSecretsReturned':0,'userIdentityExternallyVerified':False,'limitations':['Config cache row equality is not provider identity or granted-scope evidence','Known credential and token databases are separately absent; no token accessor was invoked']}

if __name__=='__main__':
    try:
        wire=sys.stdin.buffer.read(131073)
        if len(wire)>131072:raise ValueError('INPUT_BOUND')
        print(json.dumps(run(json.loads(wire))))
    except Exception:
        print(json.dumps({'status':'SAFE_REJECTION','rawErrorSuppressed':True,'providerRequests':0}));sys.exit(1)
