import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { paintCloudField } from './sky.js';
import { FRAME, focal, landmarks, atDepth, onGround, groundY } from './calibration.js';

// [M03] Deterministic construction: the same seed gives the same leaf/cloud/book placement.
let seed=91827;
const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
const between=(a,b)=>a+(b-a)*random();
const scene=new THREE.Scene();
scene.background=new THREE.Color('#6e98cc');
scene.fog=new THREE.FogExp2('#eaa77c',0.0024);
const camera=new THREE.PerspectiveCamera(FRAME.fov,FRAME.width/FRAME.height,0.08,2400);
camera.setViewOffset(FRAME.width,FRAME.height,FRAME.width/2-FRAME.cx,FRAME.height/2-FRAME.cy,FRAME.width,FRAME.height);
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.12;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
document.querySelector('#stage').append(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=false;controls.maxDistance=250;controls.minDistance=1;controls.maxPolarAngle=Math.PI*.92;
const world=new THREE.Group();world.name='真实空间几何';scene.add(world);
const decor=new THREE.Group();decor.name='远景天空';scene.add(decor);
const cube=new THREE.BoxGeometry(1,1,1);
const materials=new Map();
function mat(color,roughness=.75,metalness=0){const key=[color,roughness,metalness].join();if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color,roughness,metalness}));return materials.get(key);}
const unlit=color=>new THREE.MeshBasicMaterial({color,toneMapped:false});
function box(name,x,y,z,w,h,d,material,parent=world){const mesh=new THREE.Mesh(cube,typeof material==='string'?mat(material):material);mesh.name=name;mesh.position.set(x,y,z);mesh.scale.set(w,h,d);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;}
function rod(name,a,b,r,material,parent=world,segments=8){const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),delta=bv.clone().sub(av);const mesh=new THREE.Mesh(new THREE.CylinderGeometry(r,r,delta.length(),segments),typeof material==='string'?mat(material):material);mesh.name=name;mesh.position.copy(av.add(bv).multiplyScalar(.5));mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());mesh.castShadow=true;parent.add(mesh);return mesh;}
function canvasTexture(w,h,paint){const c=document.createElement('canvas');c.width=w;c.height=h;paint(c.getContext('2d'),w,h);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=renderer.capabilities.getMaxAnisotropy();return t;}
function plane(name,w,h,position,material,parent=world){const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),material);mesh.name=name;mesh.position.set(...position);parent.add(mesh);return mesh;}
function label(text,w,h,{bg='#eee7d5',fg='#1e3653',font=50,sub='',border=true}={}){
  const texture=canvasTexture(768,Math.round(768*h/w),(ctx,cw,ch)=>{ctx.fillStyle=bg;ctx.fillRect(0,0,cw,ch);if(border){ctx.strokeStyle=fg;ctx.lineWidth=5;ctx.strokeRect(8,8,cw-16,ch-16);}ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=fg;ctx.font=`500 ${font}px "Yu Gothic",sans-serif`;ctx.fillText(text,cw/2,ch*(sub?.38:.5),cw*.92);if(sub){ctx.font='38px sans-serif';ctx.fillText(sub,cw/2,ch*.78,cw*.9);}});
  return new THREE.MeshStandardMaterial({map:texture,roughness:.8});
}

// [M04] Procedural painted sky. No source-image pixels are sampled by this renderer.
const skyTexture=canvasTexture(2400,1350,(ctx,w,h)=>{
 const sx=w*954/1672,sy=h*529/941;
 const gradient=ctx.createLinearGradient(0,0,0,h);for(const [p,c] of [[0,'#2262ae'],[.28,'#528dcb'],[.46,'#ed9c96'],[.58,'#ffd77e'],[.72,'#f5b27b'],[1,'#ac7d9b']])gradient.addColorStop(p,c);ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
 const glow=ctx.createRadialGradient(sx,sy,0,sx,sy,w*.36);glow.addColorStop(0,'#ffffba');glow.addColorStop(.08,'#ffe594dd');glow.addColorStop(.35,'#ffc76f55');glow.addColorStop(1,'#ffb95a00');ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
 paintCloudField(ctx,w,h);
 // Broad, low-opacity crepuscular rays converge on the same sun landmark.
 ctx.globalCompositeOperation='screen';for(let i=0;i<15;i++){const angle=between(-2.8,-.3),length=between(250,1300);ctx.fillStyle=`rgba(255,227,145,${between(.012,.045)})`;ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(sx+Math.cos(angle-.015)*length,sy+Math.sin(angle-.015)*length);ctx.lineTo(sx+Math.cos(angle+.015)*length,sy+Math.sin(angle+.015)*length);ctx.fill();}ctx.globalCompositeOperation='source-over';
 const halo=ctx.createRadialGradient(sx,sy,2,sx,sy,80);halo.addColorStop(0,'#ffffde');halo.addColorStop(.2,'#ffffbfaa');halo.addColorStop(1,'#ffe67c00');ctx.fillStyle=halo;ctx.fillRect(sx-80,sy-80,160,160);ctx.fillStyle='#ffffe3';ctx.beginPath();ctx.arc(sx,sy,22,0,Math.PI*2);ctx.fill();
});
const skyDepth=1200,skyH=FRAME.height*skyDepth/focal;
plane('程序绘制的云层与太阳',skyH*FRAME.width/FRAME.height,skyH,atDepth(FRAME.width/2,FRAME.height/2,skyDepth),new THREE.MeshBasicMaterial({map:skyTexture,toneMapped:false,depthWrite:false,fog:false}),decor);

// [M05] Light directions agree with the low distant sun; windows own local warm emitters.
scene.add(new THREE.HemisphereLight('#b2cbff','#766067',2.6));
const bounce=new THREE.DirectionalLight('#ffd5b0',.7);bounce.name='立面暖色环境反弹补光';bounce.position.set(-25,15,15);scene.add(bounce);
const sun=new THREE.DirectionalLight('#ffbe69',2.7);sun.position.set(0,24,-130);sun.target.position.set(0,-2,-12);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-36,right:36,top:35,bottom:-30,near:.5,far:230});sun.shadow.bias=-.00025;sun.shadow.normalBias=.025;scene.add(sun,sun.target);

// [M06] A sloping world plane, not a trapezoid facing the camera.
const asphaltTex=canvasTexture(1024,1024,(ctx,w,h)=>{ctx.fillStyle='#767381';ctx.fillRect(0,0,w,h);for(let i=0;i<125000;i++){const c=between(35,140);ctx.fillStyle=`rgba(${c+12},${c+6},${c},${between(.15,.8)})`;ctx.fillRect(random()*w,random()*h,between(.5,2),between(.5,2));}for(let i=0;i<220;i++){ctx.strokeStyle='#242d3940';ctx.beginPath();const x=random()*w,y=random()*h;ctx.moveTo(x,y);ctx.lineTo(x+between(-60,60),y+between(-5,5));ctx.stroke();}});
asphaltTex.wrapS=asphaltTex.wrapT=THREE.RepeatWrapping;asphaltTex.repeat.set(4,30);
// A diffuse asphalt substrate avoids a broad metallic highlight; water is a separate layer.
const roadMat=new THREE.MeshLambertMaterial({map:asphaltTex,color:'#ffffff'});
function groundRect(name,x,z,w,d,material,offset=0){const m=plane(name,w,d,[x,groundY(z)+offset,z],material);m.rotation.x=-Math.PI/2-Math.atan(FRAME.slope);m.receiveShadow=true;return m;}
groundRect('下坡沥青道路',3,-125,10.7,260,roadMat);
groundRect('左侧步道基层',-6.25,-120,7.7,260,mat('#8b8190'),.12);
groundRect('右侧步道基层',10.5,-120,4.5,260,mat('#aaa1a4'),.12);
const sidewalkGeometries=[];
for(const side of [-1,1])for(let row=0;row<105;row++)for(let col=0;col<(side<0?9:5);col++){
 const x=side<0?-9.9+col*.82:8.55+col*.82,z=2-row*.85;
 const geom=new THREE.BoxGeometry(.79,.13,.82);geom.rotateX(-Math.atan(FRAME.slope));geom.translate(x,groundY(z)+.17,z);sidewalkGeometries.push(geom);
}
const paving=new THREE.Mesh(mergeGeometries(sidewalkGeometries),mat('#a49aa1',.4));paving.receiveShadow=true;paving.name='逐块铺设的人行道砖';world.add(paving);sidewalkGeometries.forEach(g=>g.dispose());
for(const x of [-2.65,8.45])for(let z=2;z>-180;z-=1.4){const m=box('路缘石',x,groundY(z)+.15,z,.32,.27,1.36,'#b4afaf');m.rotation.x=-Math.atan(FRAME.slope);}
const marking=mat('#e0d3c4',.65);
for(let x=-1.85;x<8.4;x+=1.6)groundRect('斑马线',x,-8.7,.88,2.35,marking,.025);
for(let z=-19;z>-180;z-=12)groundRect('道路中心虚线',3,z,.13,5.2,marking,.024);
for(const x of [-2.27,8.07])groundRect('道路边线',x,-110,.085,230,marking,.02);
for(let x=-1.5;x<8.2;x+=1.8)groundRect('远处过街线',x,-34,.9,1.6,marking,.027);
// Thin fragments on the actual ground capture a broken, wet sunset reflection.
const glints=[];const glowMaterials=['#ffdc86','#ffe6a5','#ffc574','#e8a473'].map(c=>new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:.38,depthWrite:false,toneMapped:false}));
const reflectionTexture=canvasTexture(512,2048,(ctx,w,h)=>{
 for(let i=0;i<34000;i++){const y=random()*h,x=w*.5+(random()+random()+random()-1.5)*w*.23;const strength=Math.exp(-(((x-w*.5)/(w*.16))**2));ctx.fillStyle=`rgba(255,${Math.floor(between(165,237))},${Math.floor(between(65,156))},${strength*between(.1,.7)})`;ctx.fillRect(x,y,between(1,16),between(.3,2.4));}
});
const reflection=groundRect('破碎水膜中的太阳倒影',0,-75,4.6,143,new THREE.MeshBasicMaterial({map:reflectionTexture,transparent:true,opacity:.88,depthWrite:false,toneMapped:false}),.038);glints.push(reflection);
for(let i=0;i<2100;i++){const d=between(6,120),spread=.1+d*.018,x=between(-spread,spread)+Math.sin(d*.11)*.15;const m=groundRect('水膜反光',x,-d,between(.01,.1)*(1+d*.013),between(.012,.065),glowMaterials[i%4],.035);glints.push(m);}

// [M07] Near facades: actual inset openings, frames, balconies and bookshop interior.
const concrete=canvasTexture(512,512,(ctx,w,h)=>{ctx.fillStyle='#c8bbc0';ctx.fillRect(0,0,w,h);for(let i=0;i<19000;i++){ctx.fillStyle=random()>.5?'#f5e7d715':'#423b4410';ctx.fillRect(random()*w,random()*h,between(1,4),between(1,7));}ctx.strokeStyle='#756e793a';ctx.lineWidth=2;for(let x=0;x<w;x+=128){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=0;y<h;y+=128){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}});
concrete.wrapS=concrete.wrapT=THREE.RepeatWrapping;concrete.repeat.set(2,3);
const wallMat=new THREE.MeshStandardMaterial({map:concrete,color:'#d7c8c8',roughness:.92});
const glass=mat('#39475a',.19,.45),frame=mat('#3b393d',.4,.5);
const warmGlass=new THREE.MeshStandardMaterial({color:'#d99549',emissive:'#ffaa38',emissiveIntensity:.8,roughness:.2,metalness:.2});
function windowFront(x,y,z,w,h,lit=false){box('窗洞阴影',x,y,z,w+.15,h+.15,.08,frame);box('玻璃窗',x,y,z+.06,w,h,.06,lit?warmGlass:glass);for(const dx of [-w/2,0,w/2])box('细窗框',x+dx,y,z+.11,.045,h+.05,.065,frame);for(const dy of [-h/2,h/2])box('窗台',x,y+dy,z+.11,w+.1,.055,.11,'#aba3a1');}
function building(x,z,w,d,h,index){const base=groundY(z);box('住宅体块 '+index,x,base+h/2,z,w,h,d,wallMat);box('屋顶压檐',x,base+h,z,w+.12,.15,d+.12,'#a6a0aa');
 const floors=Math.floor(h/2.8),cols=Math.max(1,Math.floor(w/2.5));for(let f=0;f<floors;f++)for(let j=0;j<cols;j++){const wx=x-w/2+(j+.5)*w/cols,wy=base+1.5+f*2.7;windowFront(wx,wy,z+d/2+.025,1.0,1.45,random()>.63);if(j%2===0&&f>0){box('阳台底板',wx,wy-.9,z+d/2+.5,1.7,.12,.9,'#b4a8aa');box('阳台栏板',wx,wy-.42,z+d/2+.91,1.7,.77,.09,'#99959e');}}
 for(let f=0;f<floors;f++)for(let j=0;j<Math.floor(d/2.7);j++){const side=x>0?-1:1,xx=x+side*(w/2+.04),zz=z-d/2+1.4+j*2.7,yy=base+1.5+f*2.7;box('侧面窗洞',xx,yy,zz,.05,1.5,1.3,frame);box('侧窗玻璃',xx+side*.035,yy,zz,.025,1.34,1.14,random()>.75?warmGlass:glass);box('侧窗中梃',xx+side*.06,yy,zz,.05,1.4,.045,frame);}
 if(x>0){for(let f=1;f<floors;f++){const yy=base+f*2.7+.62,xx=x-w/2-.68,zz=z+d/2-1.9;box('侧阳台悬挑板',xx,yy,zz,1.45,.12,2.4,'#b6adb0');rod('侧阳台扶手',[xx-.68,yy+1.05,zz-1.17],[xx-.68,yy+1.05,zz+1.17],.024,'#69666b');for(let j=0;j<9;j++){const pz=zz-1.15+j*.285;rod('侧阳台栏杆',[xx-.68,yy,pz],[xx-.68,yy+1.05,pz],.015,'#767174');}}}
 const tank=box('屋顶设备',x+w*.2,base+h+.5,z,1.2,1,1,'#9796a1');rod('天线',[x,base+h,z],[x,base+h+1.9,z],.025,'#625c6a');rod('天线横杆',[x-.65,base+h+1.5,z],[x+.65,base+h+1.5,z],.022,'#625c6a');return tank;
}
// Left bookshop is open geometry: books remain visible from a changed viewpoint.
const shopStart=world.children.length;
const shopX=-10.6,shopZ=-11.8,shopBase=groundY(shopZ);
box('书店左墙',-14,shopBase+5.8,shopZ,.25,11.6,12,wallMat);
box('书店后墙',shopX,shopBase+5.8,-17.7,7,11.6,.3,wallMat);
box('书店上层',shopX,shopBase+7.6,shopZ,7,7.8,12,wallMat);
box('书店底板',shopX,shopBase+.12,shopZ,7,.24,12,'#c5a37c');
box('书店顶棚',shopX,shopBase+3.8,shopZ,7,.18,12,'#89766c');
for(const z of [-6,-10,-14,-17.6])box('店面立柱',-7.03,shopBase+1.9,z,.3,3.8,.23,wallMat);
const storefrontGlow=new THREE.MeshStandardMaterial({color:'#fbd49a',emissive:'#ffaf46',emissiveIntensity:1.8,side:THREE.DoubleSide});
for(const z of [-8,-12,-16]){
 box('橱窗内部暖墙',-10.7,shopBase+1.75,z,.14,3.2,3.7,mat('#d5ab6b'));
 box('橱窗顶部灯带',-7.3,shopBase+3.58,z,.5,.075,3.5,storefrontGlow);
 for(const level of [.35,1.05,1.75,2.45]){box('书架搁板',-8.7,shopBase+level,z,.8,.07,3.3,'#744f39');for(let j=0;j<19;j++){const height=between(.25,.54),colors=['#61434a','#b6a684','#616d72','#e4c8a3','#a07149','#46636c'];box('书脊',-8.6,shopBase+level+height/2+.05,z-1.48+j*.16,.42,height,between(.07,.135),colors[Math.floor(random()*colors.length)]);}}
 for(const zz of [z-1.7,z+1.7])box('橱窗金属框',-6.84,shopBase+1.8,zz,.09,3.5,.075,frame);
 const light=new THREE.PointLight('#ffab46',38,8,2);light.position.set(-7.5,shopBase+2.8,z);world.add(light);
}
const shopSign=box('书店招牌实体',-6.88,shopBase+4.3,-11.8,.28,1.15,12.4,'#454955');
const sign=plane('やすらぎ書店',9.6,.95,[-6.715,shopBase+4.3,-11.6],label('やすらぎ書店',9.6,.95,{bg:'#414752',fg:'#e0cbc9',font:65,border:false}));sign.rotation.y=Math.PI/2;
for(const z of [-8,-13]){box('上层大窗外框',-7.02,shopBase+7.8,z,.07,3.5,3.35,frame);box('上层夕照玻璃',-6.97,shopBase+7.8,z,.04,3.25,3.1,glass);box('上层窗竖框',-6.92,shopBase+7.8,z,.08,3.35,.075,frame);}
const board=box('书店门口立式黑板',-7.9,groundY(-5.9)+.85,-5.9,1.05,1.65,.13,'#88603d');
plane('黑板手写字',.88,1.45,[-7.9,groundY(-5.9)+.88,-5.82],label('本 と',.88,1.45,{bg:'#303c4b',fg:'#e5d4ce',font:112,sub:'いい時間',border:false}));
rod('黑板后支腿',[-7.5,groundY(-6.6),-6.6],[-7.5,groundY(-5.9)+1.55,-5.9],.035,'#997046');
for(const mesh of world.children.slice(shopStart))mesh.position.x-=3.3;
building(16.5,-28,9,11,12,0);building(17,-44,8,10,10.5,1);building(15.5,-60,7,10,9,2);building(16,-79,8,12,8,3);
building(-13.5,-35,8,11,9,4);building(-14,-52,8,10,10,5);building(-11,-74,7,13,7,6);
for(let i=0;i<30;i++){const side=i%2?1:-1,z=-94-Math.floor(i/2)*11;building(side<0?between(-19,-10):between(17,29),z,between(5,9),between(6,10),between(4,11),i+7);}
// Distant city terminates the downhill view before the mountain silhouette.
for(let i=0;i<160;i++){const z=between(-390,-160),x=between(-150,160),h=between(3,18),y=groundY(z);box('远城建筑',x,y+h/2,z,between(3,8),h,between(4,8),['#a88e9d','#af969e','#bca0a6','#a395a8'][i%4]);if(i%3===0)box('远城受光屋顶',x,y+h,z,4,.2,4,'#f1c298');}

// [M08] Walls and guardrails are depth-repeated geometry, not screen-space strokes.
for(const side of [-1,1]){const wallX=side<0?-8.8:12.8;
 for(let z=-21;z>-160;z-=3){box('街道围墙',wallX,groundY(z)+1,z,.22,2,2.96,wallMat);box('围墙压顶',wallX,groundY(z)+2.06,z,.3,.12,3,'#bfb3b0');}
 const railX=side<0?-3.25:9.05;
 for(let z=-9;z>-150;z-=4){const a=groundY(z),b=groundY(z-4);rod('护栏立杆',[railX,a+.18,z],[railX,a+1.05,z],.045,'#384953');for(const height of [.56,1.02])rod('护栏横杆',[railX,a+height,z],[railX,b+height,z-4],.033,'#55616a');}
}

// [M09] Ground-anchored poles. Endpoint pixels set height; depth follows ground intersection.
const poleMaterial=mat('#666976',.65,.25);
function utilityPole(u,v,topV,name){const foot=onGround(u,v),d=-foot[2],top=atDepth(u,topV,d);rod(name,foot,top,d*.0009+0.05,poleMaterial,world,12);const h=top[1]-foot[1];
 for(let y=foot[1]+.5;y<top[1];y+=.85){const band=new THREE.Mesh(new THREE.CylinderGeometry(d*.001+.063,d*.001+.063,.055,12),mat('#333d4b',.4,.5));band.position.set(foot[0],y,foot[2]);world.add(band);}
 for(const height of [.75,.91]){const y=foot[1]+h*height;rod('电杆横担',[foot[0]-.55,y,foot[2]],[foot[0]+.55,y,foot[2]],.044,'#37414c');for(const x of [-.48,.4])rod('瓷绝缘子',[foot[0]+x,y,foot[2]],[foot[0]+x,y+.26,foot[2]],.062,'#7c8b99');}
 if(name.includes('左')){box('电杆设备箱',foot[0]-.2,foot[1]+1.8,foot[2]+.05,.42,1.05,.35,'#9b9da1');box('高处变压器',foot[0]+.37,top[1]-.6,foot[2],.4,.7,.4,'#5a6571');}
 return {foot,top,d,h};
}
const leftPole=utilityPole(...landmarks.leftPoleFoot,-85,'左前主电杆'),rightPole=utilityPole(...landmarks.rightPoleFoot,222,'右前主电杆');
function wire(a,b,sag=.9,r=.011){const midpoint=new THREE.Vector3(...a).lerp(new THREE.Vector3(...b),.5);midpoint.y-=sag;const curve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(...a),midpoint,new THREE.Vector3(...b));const mesh=new THREE.Mesh(new THREE.TubeGeometry(curve,32,r,5,false),mat('#333e4c',.8));mesh.name='下垂架空电缆';world.add(mesh);}
for(let i=0;i<5;i++){wire([leftPole.top[0]+i*.1,leftPole.top[1]-.25-i*.12,leftPole.top[2]],[rightPole.top[0]+i*.1,rightPole.top[1]-.8-i*.1,rightPole.top[2]],1.8+i*.2,.009);}
for(const [side,pole] of [[-1,leftPole],[1,rightPole]]){let previous=pole;for(const d of [42,72,110,165]){const x=side<0?-7.8:13.7,y=groundY(-d),foot=[x,y,-d],top=[x,y+9,-d];rod('纵深电杆',foot,top,.09,poleMaterial);rod('纵深横担',[x-.65,y+8,-d],[x+.65,y+8,-d],.034,'#404855');for(let j=0;j<4;j++)wire([previous.top[0]+(j-1.5)*.22,previous.top[1]-.65,previous.top[2]],[x+(j-1.5)*.22,y+8,-d],1.4,.012);previous={top};}}
// Traffic light and road-name sign calibrated against the reference photograph.
const signalP=atDepth(...landmarks.signal,leftPole.d),signP=atDepth(...landmarks.roadSign,leftPole.d);
rod('交通灯横臂',[leftPole.foot[0],signalP[1],leftPole.foot[2]],signalP,.052,'#4d5661');
box('信号灯壳体',...signalP,1.56,.52,.34,'#3c424d');
for(let i=0;i<3;i++){const lightMat=i===0?new THREE.MeshStandardMaterial({color:'#acf0c8',emissive:'#8affd1',emissiveIntensity:2}):mat(i===1?'#514a37':'#4f383b');const light=new THREE.Mesh(new THREE.CylinderGeometry(.195,.195,.08,32),lightMat);light.rotation.x=Math.PI/2;light.position.set(signalP[0]-.5+i*.5,signalP[1],signalP[2]+.21);world.add(light);const visor=new THREE.Mesh(new THREE.CylinderGeometry(.221,.221,.27,24,1,true,0,Math.PI),frame);visor.rotation.x=Math.PI/2;visor.rotation.z=0;visor.position.set(signalP[0]-.5+i*.5,signalP[1]+.01,signalP[2]+.05);world.add(visor);}
box('路牌底板',...signP,1.85,.78,.08,'#aeb7b9');plane('桜が丘通り路牌',1.78,.7,[signP[0],signP[1],signP[2]+.05],label('桜が丘通り',1.78,.7,{sub:'Sakuragaoka-dori',font:104}));
function roundSign(v,speed){const p=atDepth(490,v,leftPole.d-.2);const texture=canvasTexture(256,256,(ctx)=>{ctx.fillStyle='#ede6cd';ctx.beginPath();ctx.arc(128,128,124,0,Math.PI*2);ctx.fill();ctx.fillStyle='#a64045';ctx.beginPath();ctx.arc(128,128,115,0,Math.PI*2);ctx.fill();ctx.fillStyle=speed?'#e6d8c6':'#204a7e';ctx.beginPath();ctx.arc(128,128,90,0,Math.PI*2);ctx.fill();if(speed){ctx.fillStyle='#315678';ctx.font='bold 122px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('40',128,139);}else{ctx.strokeStyle='#b13c40';ctx.lineWidth=25;ctx.beginPath();ctx.moveTo(63,63);ctx.lineTo(193,193);ctx.stroke();}});const m=new THREE.Mesh(new THREE.CircleGeometry(.34,48),new THREE.MeshStandardMaterial({map:texture,side:THREE.DoubleSide}));m.position.set(...p);world.add(m);return p;}
const signFoot=roundSign(503,true);roundSign(554,false);rod('标志支杆',[signFoot[0],groundY(signFoot[2]),signFoot[2]],[signFoot[0],signFoot[1]+.35,signFoot[2]],.022,'#aaadb3');
const bannerP=atDepth(422,371,leftPole.d+.2);plane('社区蓝色条幅',.58,2.1,bannerP,label('未来へ',.58,2.1,{bg:'#4b6987',fg:'#d9d3d6',font:125,sub:'やさしい街',border:true}));
// Curved streetlight over the right-hand pavement.
const lampTop=rightPole.top;const lampEnd=[lampTop[0]-3.4,lampTop[1]-4.15,lampTop[2]];const lampCurve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(lampTop[0],lampTop[1]-6,lampTop[2]),new THREE.Vector3(lampTop[0]+.2,lampTop[1]-4,lampTop[2]),new THREE.Vector3(...lampEnd));world.add(new THREE.Mesh(new THREE.TubeGeometry(lampCurve,28,.035,7,false),poleMaterial));box('路灯灯头',...lampEnd,.6,.11,.22,'#76808b');

// [M10] Trees: tapered branch networks plus individually oriented instanced leaves.
const leafGeometry=new THREE.IcosahedronGeometry(1,0);leafGeometry.scale(1,.25,.52);
const foliage=new THREE.InstancedMesh(leafGeometry,new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.92}),52000);foliage.name='单叶实例树冠';foliage.castShadow=true;foliage.receiveShadow=true;world.add(foliage);
let leafCount=0;const dummy=new THREE.Object3D(),leafColor=new THREE.Color();
function tree(x,z,height,radius,count){const y=groundY(z);rod('树干',[x,y,z],[x+.13,y+height*.74,z],height*.025,'#4b443f',world,7);
 const clusters=[];for(let k=0;k<9;k++){const angle=k*2.4,cx=x+Math.cos(angle)*radius*.55,cy=y+height*(.62+.3*random()),cz=z+Math.sin(angle)*radius*.55;rod('分枝',[x,y+height*.4,z],[cx,cy,cz],.04,'#5b5143',world,5);clusters.push([cx,cy,cz]);}
 for(let i=0;i<count&&leafCount<52000;i++){const [cx,cy,cz]=clusters[i%clusters.length],a=between(0,Math.PI*2),r=Math.cbrt(random())*radius*.7,vy=between(-1,1);dummy.position.set(cx+Math.cos(a)*r*Math.sqrt(1-vy*vy),cy+vy*r*.8,cz+Math.sin(a)*r*Math.sqrt(1-vy*vy));dummy.rotation.set(between(0,Math.PI),between(0,Math.PI),between(0,Math.PI));const s=between(.065,.135)*(height/5)**.5;dummy.scale.set(s,s*between(.7,1.2),s);dummy.updateMatrix();foliage.setMatrixAt(leafCount,dummy.matrix);const gold=random()>.66;leafColor.set(gold?['#a89029','#d3a22d','#bd8521'][i%3]:['#304e48','#3e5c45','#516546','#697345'][i%4]);foliage.setColorAt(leafCount++,leafColor);}
}
tree(-8,-6,7.3,3.4,10500);tree(-9,-23,5.4,2.4,3800);tree(-9.7,-31,5.2,2.6,3800);tree(-9,-44,6,2.5,3000);tree(13.4,-26,5.6,2.7,4000);tree(12.8,-42,5.4,2.3,3500);tree(12.5,-59,5.4,2.4,3000);
for(let i=0;i<18;i++)tree(i%2?-8.8:14.6,-56-i*7,between(3.5,5.5),between(1.2,2),650);
for(const [x,z] of [[-7.4,-7],[-6.8,-15],[-7.6,-18]]){const y=groundY(z);const pot=new THREE.Mesh(new THREE.CylinderGeometry(.3,.21,.46,8),mat('#81634d'));pot.position.set(x,y+.29,z);world.add(pot);tree(x,z,1.25,.5,400);}
foliage.count=leafCount;foliage.instanceMatrix.needsUpdate=true;foliage.instanceColor.needsUpdate=true;

// [M11] Layered mountain meshes with atmospheric color, behind the modeled city.
for(let layer=0;layer<4;layer++){const d=520+layer*100,points=[];for(let i=0;i<=85;i++){const x=-500+i*12;const y=3-layer*4+9*Math.sin(i*.26+layer)+5*Math.sin(i*.72+layer)+between(-2,2);points.push(new THREE.Vector2(x,y));}points.push(new THREE.Vector2(520,-150),new THREE.Vector2(-500,-150));const m=new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(points)),new THREE.MeshBasicMaterial({color:['#a986a5','#bb8da9','#d09aaa','#dfabaf'][layer],fog:false}));m.position.z=-d;m.name='远山第 '+layer+' 层';decor.add(m);}

// [M12] Inspection stays optional; reference is never part of the 3D materials.
let structure=false;
const leafColors=foliage.instanceColor;
const clay=new THREE.MeshStandardMaterial({color:'#c8cbd3',roughness:1});
function draw(){const start=performance.now();renderer.render(scene,camera);renderer.domElement.dataset.drawCalls=String(renderer.info.render.calls);renderer.domElement.dataset.triangles=String(renderer.info.render.triangles);renderer.domElement.dataset.renderMs=(performance.now()-start).toFixed(1);}
function reset(){camera.position.set(0,FRAME.cameraHeight,0);controls.target.set(0,FRAME.cameraHeight,-35);camera.lookAt(controls.target);controls.update();draw();}
function resize(){const width=Math.min(innerWidth,innerHeight*FRAME.width/FRAME.height),height=width*FRAME.height/FRAME.width;renderer.setSize(width,height);draw();}
document.querySelector('#reset').onclick=reset;
document.querySelector('#orbit').onclick=()=>{camera.position.set(44,32,37);controls.target.set(1,-2,-34);controls.update();draw();};
document.querySelector('#structure').onclick=event=>{structure=!structure;foliage.instanceColor=structure?null:leafColors;foliage.material.needsUpdate=true;world.traverse(o=>{if(!o.isMesh)return;if(structure){o.userData.originalMaterial=o.material;o.material=clay;}else if(o.userData.originalMaterial)o.material=o.userData.originalMaterial;});decor.visible=!structure;glints.forEach(m=>m.visible=!structure);event.currentTarget.setAttribute('aria-pressed',String(structure));draw();};
document.querySelector('#compare').onclick=event=>{const img=document.querySelector('#reference'),show=img.style.display!=='block';img.style.display=show?'block':'none';event.currentTarget.setAttribute('aria-pressed',String(show));};
addEventListener('keydown',event=>{if(event.key.toLowerCase()==='h')document.body.classList.toggle('clean');if(event.key==='Escape')reset();});
controls.addEventListener('change',draw);addEventListener('resize',resize);
addEventListener('error',event=>document.querySelector('#error').textContent=event.message);
reset();resize();
window.reconstruction={scene,camera,renderer,controls,reset,draw,landmarks,leafCount,ready:true};
document.body.dataset.ready='true';





