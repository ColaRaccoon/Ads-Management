"""Disjoint streaming continuation for local text files excluded by the 1MiB bound."""
import hashlib, importlib.util, json, os, pathlib, re, sys
_spec=importlib.util.spec_from_file_location('bounded',pathlib.Path(__file__).with_name('phase10-independent-google-consumers-v3-20261021.py'))
m=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(m)

def stream_file(path, needles):
    found={k:False for k in needles};sha=hashlib.sha256();tail=b'';count=0
    overlap=max(len(v) for v in needles.values())-1
    with path.open('rb') as f:
        while True:
            wire=f.read(65536)
            if not wire:break
            sha.update(wire);count+=len(wire);window=tail+wire
            for key,value in needles.items():found[key] |= value in window
            tail=window[-overlap:]
    return found,sha.hexdigest(),count

def run(payload):
    needles={k:payload['expected'][k].encode() for k in ('client_id','client_secret','refresh_token')}
    needles['capsule']=payload['capsule'].encode();files=[];matches=[];total=0
    for root in payload['roots']:
        base=pathlib.Path(root['path']);m.no_reparse(base)
        for parent,dirs,names in os.walk(base,followlinks=False):
            dirs[:]=[name for name in sorted(dirs) if name not in m.EXCLUDED and not re.match(r'^(?:candidate-|upload-|dependency-|portable-build-)',name) and not pathlib.Path(parent,name).is_symlink() and not getattr(pathlib.Path(parent,name).lstat(),'st_file_attributes',0)&0x400]
            for name in sorted(names):
                p=pathlib.Path(parent,name)
                if not(p.suffix.lower() in m.TEXT or name.startswith('.env')):continue
                if p.is_symlink() or getattr(p.lstat(),'st_file_attributes',0)&0x400:continue
                size=p.stat().st_size
                if size<=m.MAX_FILE:continue
                if len(files)>=32 or total+size>134217728:raise ValueError('CONTINUATION_BOUND')
                hit,sha,n=stream_file(p,needles)
                if n!=size or p.stat().st_size!=size:raise ValueError('FILE_SIZE_DRIFT')
                total+=n;row={'scope':root['label'],'pathSha256':m.digest(str(p.resolve()).casefold()),'fileSha256':sha,'bytes':n,'generatedReports': 'reports' in p.parts,'clientIdLiteralMatch':hit['client_id'],'clientSecretLiteralMatch':hit['client_secret'],'refreshTokenLiteralMatch':hit['refresh_token'],'exactCapsuleLiteralMatch':hit['capsule'],'liveConsumptionProven':False}
                files.append(row)
                if any(hit.values()):matches.append(row)
    out={'kind':'GOOGLE_DISJOINT_OVERSIZED_LOCAL_TEXT_CONTINUATION','status':'PASS_BOUNDED_LOCAL_READ_ONLY','counters':{'filesRead':len(files),'bytesRead':total,'budgetReached':False},'files':files,'matches':matches,'disjointFromEarlierScan':True,'perFileMinimumExclusiveBytes':m.MAX_FILE,'allEligibleOversizedFilesCompleted':True,'providerRequests':0,'oauthRefreshPosts':0,'rawValuesReturned':0,'limitations':['A stored report occurrence is not an active consumer; reports are read only for literal equality','Selected local roots only, encrypted backups and remote/other machines excluded']}
    encoded=json.dumps(out)
    if any(v.decode() in encoded for v in needles.values()):raise ValueError('OUTPUT_LITERAL')
    return out

if __name__=='__main__':
    try:
        wire=sys.stdin.buffer.read(131073)
        if len(wire)>131072:raise ValueError('INPUT_BOUND')
        print(json.dumps(run(json.loads(wire))))
    except Exception:
        print(json.dumps({'status':'SAFE_REJECTION','rawErrorSuppressed':True,'providerRequests':0}));sys.exit(1)
