import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// A self-contained UI study: all edits stay in this page's memory.
const $ = (selector) => document.querySelector(selector);
const menuItems = {
  文件: [['新建地图', 'demo', 'Ctrl N'], ['打开地图库…', 'demo'], ['保存', 'demo', 'Ctrl S'], ['—'], ['导入场景…', 'demo'], ['导出场景包…', 'demo']],
  编辑: [['撤销', 'demo', 'Ctrl Z'], ['重做', 'demo', 'Ctrl Shift Z'], ['—'], ['选择', 'demo'], ['移动', 'demo'], ['旋转', 'demo'], ['缩放', 'demo'], ['—'], ['复制对象', 'demo'], ['删除对象', 'demo']],
  地图: [['地形编辑', 'demo'], ['地表绘制', 'demo'], ['草地与植被', 'demo'], ['—'], ['生态分区', 'demo'], ['地图拼接', 'demo'], ['地图设置…', 'properties']],
  资产: [['资产库…', 'demo'], ['创建资产…', 'demo'], ['导入资产…', 'demo']],
  生成: [['AI 生成地图…', 'generate'], ['调整当前地图…', 'refine'], ['—'], ['生成记录…', 'demo'], ['实验工作台…', 'demo']],
  渲染: [['光照与氛围…', 'render'], ['渲染方案库…', 'demo'], ['材质与色卡…', 'demo'], ['—'], ['高级渲染设置…', 'demo']],
  视图: [['透视视图', 'reset', 'Home'], ['俯视图', 'top'], ['—'], ['显示 / 隐藏网格', 'grid'], ['专注视图', 'focus', 'Shift Space']],
  窗口: [['场景层级', 'hierarchy'], ['属性', 'properties'], ['AI 生成', 'generate'], ['—'], ['收起所有面板', 'close-panels']],
};
$('#menus').innerHTML = Object.entries(menuItems).map(([name, items], index) => `<div class="menu"><button aria-expanded="false" aria-controls="menu-${index}">${name}</button><div class="dropdown" id="menu-${index}" hidden>${items.map(([label, action, key]) => label === '—' ? '<hr>' : `<button data-action="${action}" data-label="${label}"><span>${label}</span>${key ? `<small>${key}</small>` : ''}</button>`).join('')}</div></div>`).join('');
function closeMenus() {
  document.querySelectorAll('.dropdown').forEach(el => el.hidden = true);
  document.querySelectorAll('.menu > button').forEach(el => el.setAttribute('aria-expanded', 'false'));
}
document.querySelectorAll('.menu > button').forEach(button => button.addEventListener('click', () => {
  const open = button.getAttribute('aria-expanded') === 'true';
  closeMenus();
  button.setAttribute('aria-expanded', String(!open));
  button.nextElementSibling.hidden = open;
}));
document.addEventListener('pointerdown', event => { if (!event.target.closest('.menu')) closeMenus(); });
function closePanels() { document.querySelectorAll('.panel').forEach(el => el.hidden = true); resize(); }
function openPanel(name) {
  const panel = $(`#${name}-panel`);
  if (name !== 'hierarchy') document.querySelectorAll('.panel:not(.left)').forEach(el => el.hidden = true);
  panel.hidden = false;
  resize();
}
let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').hidden = true, 3500);
}
let seed = 38;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#20201f');
scene.fog = new THREE.Fog('#20201f', 100, 200);
const camera = new THREE.PerspectiveCamera(36, 1, .1, 250);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;
controls.minDistance = 19;
controls.maxDistance = 105;
controls.maxPolarAngle = Math.PI / 2.12;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
const hemi = new THREE.HemisphereLight('#c9e8f3', '#776c4f', 2.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#ffe7bf', 3.2);
sun.position.set(-22, 36, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 110 });
sun.shadow.normalBias = .035;
scene.add(sun);
const materials = new Map();
function material(color) {
  if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: .88, flatShading: true }));
  return materials.get(color);
}
const world = new THREE.Group(); scene.add(world);
function mesh(geometry, color, x, y, z, parent = world) {
  const object = new THREE.Mesh(geometry, material(color));
  object.position.set(x, y, z); object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
}
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
function box(x, y, z, w, h, d, color, parent = world) {
  const m = mesh(boxGeometry, color, x, y, z, parent); m.scale.set(w, h, d); return m;
}
function cylinder(x, y, z, top, bottom, height, color, sides = 12, parent = world) {
  return mesh(new THREE.CylinderGeometry(top, bottom, height, sides), color, x, y, z, parent);
}
// Two irregular banks leave a continuous water channel under the bridge.
function bank(points, height, color) {
  const shape = new THREE.Shape(); points.forEach(([x,z], i) => i ? shape.lineTo(x,-z) : shape.moveTo(x,-z)); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth:height, bevelEnabled:false }); g.rotateX(-Math.PI/2);
  const side = mesh(g, '#8a8876', 0, -1.1, 0);
  const top = new THREE.ShapeGeometry(shape); top.rotateX(-Math.PI/2); mesh(top, color, 0, height-1.09, 0);
  return side;
}
bank([[-21,-13],[-16,-18],[-9,-18],[-6,-14],[-5,-8],[-3,-2],[-4,5],[-7,13],[-13,16],[-20,12],[-23,5],[-24,-5]], 2.0, '#8f9c65');
bank([[2,-16],[10,-18],[18,-13],[22,-6],[23,3],[19,12],[12,16],[5,13],[1,7],[0,2],[1,-6]], 2.0, '#96a671');
const water = box(0,-.83,0,53,.38,43,'#5c9aab'); water.castShadow = false;
box(0,-1.5,0,53,1,43,'#444f58');
box(0,-2.1,0,54,.25,44,'#303c45');
const ground = box(0,-2.45,0,300,.2,300,'#20201f'); ground.castShadow=false;
ground.material = new THREE.MeshBasicMaterial({ color:'#20201f', toneMapped:false });
const grid = new THREE.GridHelper(150, 60, '#7c898f', '#616e79'); grid.position.y=-2.33; grid.visible=false; scene.add(grid);
// Shallow strips provide readable water scale without an animated distraction.
for(let i=0;i<60;i++) {
  const x=(random()-.5)*51,z=(random()-.5)*41;
  if ((x > -4 && x < 1) || Math.abs(z)>17 || Math.abs(x)>24) { const m=box(x,-.62,z,.35+random()*1.4,.012,.035,'#a3c7c8');m.castShadow=false; }
}
function path(points,width=1.35) {
  for(let i=1;i<points.length;i++) { const [ax,az]=points[i-1], [bx,bz]=points[i];const m=box((ax+bx)/2,.94,(az+bz)/2,width,.065,Math.hypot(bx-ax,bz-az),'#c4b28a');m.rotation.y=Math.atan2(bx-ax,bz-az); }
}
path([[-18,7],[-13,4],[-9,1],[-5,0],[1,0],[7,0],[11,-5],[11,-10]]);
path([[-12,4],[-11,9],[-9,12]],1.1);path([[7,0],[11,4],[16,5]],1.1);path([[-9,1],[-12,-5],[-15,-10]],1.1);
// Bridge side profiles contain actual arch openings.
const bridgeShape = new THREE.Shape();
bridgeShape.moveTo(-5.8,.65); bridgeShape.lineTo(-5.8,1.42);bridgeShape.lineTo(2.1,1.42);bridgeShape.lineTo(2.1,.65);bridgeShape.lineTo(.7,.65);bridgeShape.lineTo(.7,-.25);bridgeShape.lineTo(-.1,-.25);bridgeShape.absarc(-1.95,-.25,1.85,0,Math.PI,false);bridgeShape.lineTo(-5.8,-.25);bridgeShape.closePath();
const bridgeGeometry=new THREE.ExtrudeGeometry(bridgeShape,{depth:.3,bevelEnabled:false});
mesh(bridgeGeometry,'#b9b19a',0,0,-1.15);mesh(bridgeGeometry,'#b9b19a',0,0,.85);
box(-1.85,1.35,0,8,.3,2.2,'#c3bda9');
for(let i=0;i<17;i++) box(-5.7+i*.48,1.51,0,.018,.015,2.1,'#a79f89');
for(const z of [-1.07,1.07]) { box(-1.85,1.96,z,8,.19,.25,'#d2cab6');for(const x of [-5.7,-4.1,-2.5,-.9,.7,2]) box(x,1.7,z,.24,.7,.27,'#b9b19a'); }
function house(x,z,w,d,h,roofColor,rotation=0) {
  const group=new THREE.Group();group.position.set(x,.95,z);group.rotation.y=rotation;world.add(group);
  box(0,.13,0,w+.3,.26,d+.3,'#8a8b7b',group);
  box(0,h/2+.2,0,w,h,d,'#e6d3a8',group);
  const roofShape=new THREE.Shape();roofShape.moveTo(-w/2-.3,0);roofShape.lineTo(0,w*.6);roofShape.lineTo(w/2+.3,0);roofShape.closePath();
  const roof=new THREE.ExtrudeGeometry(roofShape,{depth:d+.6,bevelEnabled:false});mesh(roof,roofColor,0,h+.18,-d/2-.3,group);
  for(const side of [-1,1]) {
    box(side*(w/2-.1),h/2, d/2+.025,.12,h,.09,'#88674d',group);
    box(side*w*.27,h*.62,d/2+.055,.58,.75,.1,'#52676a',group);
    box(side*w*.27,h*.62,d/2+.12,.045,.79,.035,'#e2bc85',group);
    box(side*w*.27,h*.62,d/2+.12,.63,.045,.035,'#e2bc85',group);
    box(side*w*.27,h*.62-.45,d/2+.17,.8,.13,.3,'#85674e',group);
  }
  box(0,.67,d/2+.04,.62,1.1,.1,'#665948',group);
  box(0,.13,d/2+.35,1.1,.18,.65,'#beb69f',group);
  box(w*.23,h+w*.28,-d*.23,.52,1.35,.53,'#a69b87',group);
  box(w*.23,h+w*.28+.7,-d*.23,.65,.13,.66,'#dad0b5',group);
  return group;
}
house(-11,-4.5,3.1,3.2,2.6,'#a9593e',.17);
house(-16,-8.5,3.2,3.7,2.9,'#b16a42',-.2);
house(-16,1,3.6,3.1,2.5,'#765954',.32);
house(-10,8,3.2,3.4,2.8,'#ad6647',Math.PI*.85);
house(7,5,3.1,3.4,2.6,'#8a6150',-.4);
house(15,1.5,3.7,4.2,3.2,'#b57249',-.25);
house(7,-6,3.0,3.3,2.7,'#7d7160',.1);
// A tiered stone lookout is the focal silhouette and anchors the rear bank.
cylinder(11,1.35,-10,4.3,4.9,1,'#829365',10);
cylinder(11,3.65,-10,1.5,1.85,4.1,'#d4c6a2',8);
cylinder(11,5.73,-10,1.77,1.77,.22,'#a69b80',8);
cylinder(11,6.35,-10,1.37,1.37,1.08,'#747e75',8);
for(let i=0;i<8;i++){const a=i*Math.PI/4;cylinder(11+Math.sin(a)*1.36,6.38,-10+Math.cos(a)*1.36,.075,.075,1.22,'#d5ccb1',5);}
cylinder(11,7.48,-10,0,2.05,1.47,'#976049',8);
cylinder(11,8.28,-10,.06,.08,.3,'#d5c5a2',6);
box(11,3.2,-8.36,.52,.95,.06,'#647270');
box(11,1.95,-8.22,.7,1.25,.1,'#6c6653');
for(let i=0;i<4;i++) box(11,.99+i*.12,-7.2-i*.24,1.3,.13+i*.24,.55,'#bbb89b');
// Market canopy, planted plots, benches, and a small landing establish scale.
for(const x of [-7.2,-5.2])for(const z of [5.7,7.6])box(x,1.85,z,.09,1.85,.09,'#80705a');
for(let i=0;i<6;i++)box(-7.35+i*.46,2.82,6.65,.48,.13,2.25,i%2?'#d9c99a':'#768b75');
box(-6.3,1.52,6.8,1.7,.14,.68,'#99794f');
for(let i=0;i<7;i++)mesh(new THREE.IcosahedronGeometry(.15,0),'#c39647',-6.95+i*.2,1.7,6.8);
box(-17,1.01,6,3.1,.16,2.6,'#726e48');
for(let i=0;i<5;i++)for(let j=0;j<4;j++)mesh(new THREE.IcosahedronGeometry(.2,0),'#8fa953',-18.15+i*.56,1.2,5.1+j*.57);
for(let i=0;i<11;i++)box(14+i*.3,.23,15.6, .28,.12,3.8,'#a38c67');
for(const x of [14,17])for(const z of [14,17.1]) cylinder(x,-.07,z,.09,.1,1.05,'#736751',6);
const boat=mesh(new THREE.SphereGeometry(1,8,6),'#987453',19,-.24,15.8);boat.scale.set(.6,.22,1.5);boat.rotation.y=-.4;
box(19,-.07,15.8,.86,.09,.24,'#cfb58c');
const treePositions=[];
const trunkGeometry=new THREE.CylinderGeometry(.09,.16,1.2,5);
const leafGeometry=new THREE.ConeGeometry(1,2.5,7);
function pine(x,z,s=1) {
  treePositions.push([x,z]);mesh(trunkGeometry,'#766344',x,1.5,z).scale.setScalar(s);
  for(let i=0;i<3;i++) {const m=mesh(leafGeometry,['#496b52','#597a56','#70915f'][i],x,1.7*s+.95+i*.62*s,z);m.scale.set(s*(1-i*.17),s*(1-i*.13),s*(1-i*.17));}
}
for(const [cx,cz,count,spread] of [[-18,-12,15,5],[-20,7,11,4],[16,-8,14,4],[16,9,12,5],[4,-12,6,3],[-13,12,7,3]]) {
  for(let i=0;i<count;i++) {const x=cx+(random()-.5)*spread,z=cz+(random()-.5)*spread;if(treePositions.every(p=>Math.hypot(p[0]-x,p[1]-z)>1.2))pine(x,z,.7+random()*.55);}
}
const rockGeometry=new THREE.DodecahedronGeometry(1,0);
for(let i=0;i<28;i++) {
  const a=i/28*Math.PI*2,x=Math.cos(a)*21,z=Math.sin(a)*15;
  const r=mesh(rockGeometry,i%2?'#a9ab98':'#939f96',x,.25,z);r.scale.set(.5+random()*.8,.4+random()*.5,.4+random()*.8);r.rotation.set(random(),random(),random());
}
for(let i=0;i<18;i++){const x=-4.3+Math.sin(i*.5)*.8,z=-10+i*1.15;const r=mesh(rockGeometry,'#c0bda5',x,.63,z);r.scale.set(.4,.34,.5);}

function render() { renderer.render(scene,camera); }
function resetView() { camera.position.set(52,44,60);controls.target.set(0,0,0);controls.update();$('#view-name').textContent='透视';render(); }
function resize() {
  const {width,height}=canvas.getBoundingClientRect();
  renderer.setSize(width,height,false);
  camera.aspect=width/Math.max(height,1);
  const panelWidth=parseFloat(getComputedStyle($('#viewport')).getPropertyValue('--right-panel'))||0;
  const unobstructedAspect=Math.max(1,width-panelWidth)/Math.max(height,1);
  camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(18))*Math.max(1,1.35/unobstructedAspect)));
  // Frame the scene beside the compact panel while keeping the canvas below it usable.
  if(panelWidth) camera.setViewOffset(width,height,panelWidth/2,0,width,height);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();render();
}
controls.addEventListener('change',()=>{ $('#camera-status').textContent=`距离 ${camera.position.distanceTo(controls.target).toFixed(1)} m`;render(); });
new ResizeObserver(resize).observe(canvas);
resetView();resize();$('#load-state').textContent='松湾 / 林间聚落';

function focusView() { const active=$('#app').classList.toggle('zen');closePanels();$('#focus').textContent=active?'退出专注':'专注';$('#focus').setAttribute('aria-pressed',String(active));resize(); }
const actions={
  demo: button=>toast(`${button.dataset.label}：仅展示入口，未接入业务功能`),
  generate: ()=>openPanel('generate'),
  refine: ()=>{openPanel('generate');$('[data-mode="refine"]').click();},
  hierarchy: ()=>openPanel('hierarchy'), properties: ()=>openPanel('properties'), render: ()=>openPanel('render'),
  'close-panels': closePanels, reset: resetView,
  top: ()=>{camera.position.set(0,68,.01);controls.target.set(0,0,0);controls.update();$('#view-name').textContent='俯视';render();},
  grid: ()=>{grid.visible=!grid.visible;$('#grid-toggle').setAttribute('aria-pressed',String(grid.visible));render();},
  focus: focusView,
  select: ()=>toast('拖动浏览场景；对象编辑未接入此原型'),
  preview: ()=>toast('这是界面原型，未调用 AI；当前场景供你预览布局和交互'),
  'map-stage': ()=>{document.querySelectorAll('.stage').forEach(el=>el.classList.toggle('active',el.dataset.action==='map-stage'));closePanels();},
  'render-stage': ()=>{document.querySelectorAll('.stage').forEach(el=>el.classList.toggle('active',el.dataset.action==='render-stage'));openPanel('render');},
};
document.addEventListener('click', event=> {
  const button=event.target.closest('button');if(!button)return;
  if(button.hasAttribute('data-close')){button.closest('.panel').hidden=true;resize();}
  if(button.dataset.action){closeMenus();actions[button.dataset.action]?.(button);}
  if(button.dataset.demo)toast(`${button.dataset.demo}仅作布局展示；视口当前用于旋转浏览`);
  if(button.dataset.mode){document.querySelectorAll('[data-mode]').forEach(el=>el.classList.toggle('active',el===button));$('#preview-button').textContent=button.dataset.mode==='new'?'生成构图预览':'预览调整结果';}
  if(button.dataset.object){document.querySelectorAll('[data-object]').forEach(el=>el.classList.toggle('selected',el===button));$('#object-name').textContent=button.dataset.object;openPanel('properties');}
  if(button.dataset.light){const sunset=button.dataset.light==='sunset';document.querySelectorAll('[data-light]').forEach(el=>el.classList.toggle('active',el===button));sun.color.set(sunset?'#ffb77b':'#ffe7bf');sun.position.set(sunset?-35:-22,sunset?13:36,18);sun.intensity=sunset?3:3.2;hemi.intensity=sunset?1.35:2.25;render();}
});
$('#exposure').addEventListener('input',event=>{renderer.toneMappingExposure=Number(event.target.value);render();});
document.addEventListener('keydown',event=>{
  if(event.target.matches('input,textarea,select'))return;
  if(event.key==='Escape'){closeMenus();closePanels();if($('#app').classList.contains('zen'))focusView();}
  if(event.key==='Home'){event.preventDefault();resetView();}
  if(event.shiftKey&&event.code==='Space'){event.preventDefault();focusView();}
});
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();$('#load-state').textContent='3D 上下文已丢失，请刷新页面';});
