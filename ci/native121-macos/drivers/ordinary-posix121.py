"""Ordinary installed CLI under an actual disposable PTY; no user state."""
import datetime,json,os,pathlib,pty,select,signal,socket,subprocess,sys,time,fcntl,termios,struct
qa=pathlib.Path(sys.argv[1]).resolve();proof=json.loads((qa/'qualification.json').read_text());version=proof['version'];commit=proof['source'];profile=qa/'profile';state=qa/'state'
platform=('macos-arm64' if os.uname().machine=='arm64' else 'macos-x86_64') if sys.platform=='darwin' else 'linux-x86_64';home=profile/'data/stackbite/app'/('stackbite-'+version+'-'+platform+'-'+commit[:12]);entry=profile/'.local/bin/stackbite';assert entry.is_file() and (home/'stackbite-tui').is_file()
env={k:v for k,v in os.environ.items() if k in ('PATH','LANG','LC_ALL','USER','LOGNAME','SHELL','TMPDIR')}
env.update(HOME=str(profile),USERPROFILE=str(profile),APPDATA=str(profile/'roaming'),LOCALAPPDATA=str(profile/'local'),XDG_CONFIG_HOME=str(profile/'config'),XDG_DATA_HOME=str(profile/'data'),XDG_STATE_HOME=str(profile/'states'),STACKBITE_STATE_DIR=str(state),STACKBITE_HOME=str(home),STACKBITE_UPDATE_CHECK='0',TERM='xterm-256color')
def stage(name):
    with (qa/'ordinary-stages.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps({'stage':name,'pid':os.getpid(),'monotonic':time.monotonic()})+'\n')
    print('ordinary-stage: '+name,flush=True)

def run(label,args):
    stage(label+'-start')
    r=subprocess.run([str(entry),*args],env=env,cwd=qa/'cwd',capture_output=True,text=True,timeout=90)
    stage(label+'-returned-'+str(r.returncode))
    (qa/('ordinary-'+label+'.private.log')).write_text(r.stdout+'\n'+r.stderr)
    assert r.returncode==0,(label,r.returncode,r.stderr[-300:]);return r.stdout
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
ready=json.loads(run('room',['--workbite-room-init',str(port)]));env['STACKBITE_ROOM_BRIDGE_URL']=ready['base_url'];child=None;fd=None;tui=None;output=b''
def tui_process():
    if sys.platform.startswith('linux'):
        for proc in pathlib.Path('/proc').glob('[0-9]*'):
            try:
                if os.readlink(proc/'exe')==str(home/'stackbite-tui'):return int(proc.name)
            except OSError:pass
    else:
        output=subprocess.check_output(['ps','-Aww','-o','pid=,comm='],text=True)
        for line in output.splitlines():
            parts=line.strip().split(None,1)
            if len(parts)==2 and parts[1]==str(home/'stackbite-tui'):return int(parts[0])
    return None
try:
    env['STACKBITE_WORKBITE_NATIVE_LAUNCH']='1';assert json.loads(run('owner',['--workbite-native-init']))['status']=='selected';env.pop('STACKBITE_WORKBITE_NATIVE_LAUNCH')
    journal=state/'.stackbite-engine-transition/current.json';journal.parent.mkdir(mode=0o700,exist_ok=True)
    payload=json.dumps({'schema':'stackbite.engine-transition.v1','phase':'pending','worker_settled':False,'targets':[],'owners':{},'cleanup_reason':None}).encode();journal.write_bytes(payload);journal.chmod(0o600)
    stage('before-pty-fork')
    child,fd=pty.fork()
    if child==0:
        os.chdir(qa/'cwd');os.execve(str(entry),[str(entry)],env)
    stage('parent-after-pty-fork')
    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
    output=b'';deadline=time.monotonic()+35
    while time.monotonic()<deadline:
        if select.select([fd],[],[],.2)[0]:
            try:output+=os.read(fd,65536)
            except OSError:break
        tui=tui_process()
        if tui and b'\x1b[' in output:break
        ended,status=os.waitpid(child,os.WNOHANG)
        if ended:child=None;raise AssertionError('ordinary launcher ended before actual TUI: '+str(status))
    assert tui and b'\x1b[' in output,'ordinary entry never reached its actual PTY frontend'
    time.sleep(1);assert tui_process()==tui;assert journal.read_bytes()==payload
    result={'version':version,'source':commit,'platform':sys.platform,'ordinary_public_entry':str(entry),'actual_pty_frontend':True,'tui_pid':tui,'pending_journal_preserved':True,'user_state_touched':False,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    stage('actual-tui-observed')
    (qa/'ordinary-entry-proof.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
finally:
    (qa/'ordinary-pty.private.log').write_bytes(output)
    stage('cleanup-before-tui-kill')
    if tui and tui_process()==tui:
        try:os.kill(tui,signal.SIGKILL)
        except ProcessLookupError:pass
    if fd is not None:os.close(fd);fd=None
    stage('cleanup-after-master-close')
    if child:
        for send_kill in (False,True):
            if send_kill:
                try:os.kill(child,signal.SIGKILL)
                except ProcessLookupError:pass
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                try:ended,_=os.waitpid(child,os.WNOHANG)
                except ChildProcessError:ended=child
                if ended:child=None;break
                time.sleep(.05)
            if child is None:break
    stage('cleanup-child-reaped' if child is None else 'cleanup-child-unreaped')
    stopped=json.JSONDecoder().raw_decode(run('stop',['stop','--full','--apply']).lstrip())[0]
    assert stopped['all_owned_stopped'] is True
    assert child is None,'PTY child did not settle after master close and owned SIGKILL'
