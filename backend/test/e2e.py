"""End-to-end API test. Needs the API and worker running, ffmpeg on PATH, and an EMPTY database.
Usage: API_URL=http://localhost:3000 python3 test/e2e.py"""
import requests, time, os, subprocess, tempfile
A=os.environ.get('API_URL','http://localhost:3000')
M=tempfile.mkdtemp(prefix='savana-media-')
def gen(name,*args): subprocess.run(['ffmpeg','-y','-loglevel','error',*args,os.path.join(M,name)],check=True)
gen('photo.jpg','-f','lavfi','-i','testsrc2=size=4096x2048:rate=1','-frames:v','1')
gen('video.mp4','-f','lavfi','-i','testsrc2=size=3840x1920:rate=24:duration=6','-f','lavfi','-i','sine=frequency=440:duration=6','-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-c:a','aac','-shortest')
gen('vr180.mp4','-f','lavfi','-i','testsrc2=size=1920x1920:rate=30:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast')
EMAIL='e2e-%d@example.com'%int(time.time())
def ok(c,m):
    print(('PASS ' if c else 'FAIL ')+m); 
    if not c: ok.f+=1
ok.f=0
r=requests.post(A+'/auth/register',json={'email':EMAIL,'password':'a-long-password','displayName':'Tester'})
ok(r.status_code==201,'register '+str(r.status_code)); tok=r.json()['token']
r=requests.post(A+'/auth/register',json={'email':EMAIL.upper(),'password':'a-long-password','displayName':'Dup'}); ok(r.status_code==409,'duplicate email (case-insens) 409 got '+str(r.status_code))
r=requests.post(A+'/auth/login',json={'email':EMAIL,'password':'wrong-password-x'}); ok(r.status_code==401,'bad login 401')
r=requests.post(A+'/auth/login',json={'email':EMAIL,'password':'a-long-password'}); ok(r.status_code==200,'login'); tok=r.json()['token']
H={'authorization':'Bearer '+tok}
ok(requests.get(A+'/me',headers=H).json()['display_name']=='Tester','/me')
ok(requests.post(A+'/experiences',json={}).status_code==401,'create needs auth')
r=requests.post(A+'/experiences',headers=H,json={'title':'x','category':'wildlife'}); ok(r.status_code==400,'validation 400')
def up(title,cat,place,lat,lon,fmt,stereo,path,ctype):
    import os
    r=requests.post(A+'/experiences',headers=H,json={'title':title,'category':cat,'placeName':place,'lat':lat,'lon':lon,'format':fmt,'stereo':stereo,'filename':os.path.basename(path),'contentType':ctype,'sizeBytes':os.path.getsize(path)})
    ok(r.status_code==201,'create '+title+' '+str(r.status_code)+r.text[:200]); d=r.json()
    u=d['upload']
    with open(path,'rb') as f: r=requests.post(u['url'],data=u['fields'],files={'file':f})
    ok(r.status_code in (200,201,204),'storage upload '+str(r.status_code)+r.text[:200])
    return d['id']
# complete before upload exists
r=requests.post(A+'/experiences',headers=H,json={'title':'Ghost','category':'city','placeName':'Nowhere','lat':0,'lon':0,'format':'photo360','filename':'a.jpg','contentType':'image/jpeg','sizeBytes':10}); gid=r.json()['id']
r=requests.post(A+f'/experiences/{gid}/complete',headers=H); ok(r.status_code==409 and 'upload_missing' in r.text,'complete without upload -> 409')
ids={}
ids['photo']=up('Mara at dawn','wildlife','Maasai Mara',-1.5,35.1,'photo360','mono',M+'/photo.jpg','image/jpeg')
ids['video']=up('Diani walk','coast','Diani',-4.3,39.58,'video360','mono',M+'/video.mp4','video/mp4')
ids['vr180']=up('Lamu dhow','culture','Lamu',-2.27,40.9,'vr180','top-bottom',M+'/vr180.mp4','video/mp4')
for k,i in ids.items():
    r=requests.post(A+f'/experiences/{i}/complete',headers=H); ok(r.status_code==202,'complete '+k+' '+str(r.status_code))
ok(requests.post(A+f'/experiences/{ids["photo"]}/complete',headers=H).status_code==409,'double complete 409')
t0=time.time(); res={}
while time.time()-t0<240 and len(res)<3:
    for k,i in ids.items():
        if k in res: continue
        s=requests.get(A+f'/experiences/{i}',headers=H).json()
        if s['status'] in('ready','failed'): res[k]=s; print(k,s['status'],round(time.time()-t0),'s',s.get('error',''))
    time.sleep(2)
for k in ids: ok(res.get(k,{}).get('status')=='ready','processed '+k)
for k,s in res.items():
    if s['status']!='ready': continue
    r=requests.get(s['playbackUrl']); ok(r.status_code==200,'playback fetch '+k+' '+s['playbackUrl'])
    if k=='vr180': ok('RESOLUTION=1920x1920' in r.text,'source resolution kept in ladder (vr180)')
    if k!='photo':
        txt=r.text; print(txt[:300]); seg=[l for l in requests.get(s['playbackUrl'].rsplit('/',1)[0]+'/v0.m3u8').text.splitlines() if l.endswith('.ts')]
        ok(bool(seg) and requests.get(s['playbackUrl'].rsplit('/',1)[0]+'/'+seg[0]).status_code==200,'segment fetch '+k)
    ok(requests.get(s['thumbUrl']).status_code==200,'thumb '+k)
    print(k,s['width'],'x',s['height'],'dur',s['durationS'])
ok(requests.get(A+f'/experiences/{gid}').status_code==404,'draft hidden from anon')
ok(requests.get(A+f'/experiences/{gid}',headers=H).status_code==200,'draft visible to owner')
L=requests.get(A+'/experiences?limit=2').json(); ok(len(L['items'])==2 and L['nextCursor'],'pagination page1')
L2=requests.get(A+'/experiences?limit=2&cursor='+L['nextCursor']).json(); ok(len(L2['items'])==1 and not L2['nextCursor'],'pagination page2')
ok(len({x['id'] for x in L['items']+L2['items']})==3,'no duplicates across pages')
ok(len(requests.get(A+'/experiences?category=coast').json()['items'])==1,'category filter')
ok(len(requests.get(A+'/experiences?bbox=34,-2,36,-1').json()['items'])==1,'bbox filter')
ok(len(requests.get(A+'/experiences?q=diani').json()['items'])==1,'text search')
ok(len(requests.get(A+'/map').json()['pins'])==3,'map pins')
ok(requests.get(A+'/experiences?cursor=garbage').status_code==400,'bad cursor 400')
requests.post(A+f'/experiences/{ids["photo"]}/view'); requests.post(A+f'/experiences/{ids["photo"]}/view')
ok(requests.get(A+f'/experiences/{ids["photo"]}').json()['viewCount']==2,'view count')
ok(requests.delete(A+f'/experiences/{ids["photo"]}').status_code==401,'delete needs auth')
ok(requests.delete(A+f'/experiences/{ids["photo"]}',headers=H).status_code==204,'delete')
ok(requests.get(A+f'/experiences/{ids["photo"]}').status_code==404,'deleted is 404')
ok(len(requests.get(A+'/me/experiences',headers=H).json()['items'])==3,'my experiences (ghost+2)')
r=requests.options(A+'/experiences',headers={'Origin':'http://localhost:5173','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'})
ok(r.headers.get('access-control-allow-origin')=='http://localhost:5173','CORS preflight allows frontend origin')
print('FAILURES',ok.f); raise SystemExit(1 if ok.f else 0)
