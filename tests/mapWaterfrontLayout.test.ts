import { describe, expect, it } from 'vitest';
import { createEmptyMap, type MapWaterBody } from '../src/shared/map';
import { carveWaterBasinInPlace, riverPathSamples, sampleRiverProfile, waterBoundaryPoints } from '../src/shared/mapWater';
import { createWaterfrontUrbanLayout, type WaterfrontUrbanLayoutOptions } from '../src/shared/mapWaterfrontLayout';
import { pointInPolygon } from '../src/shared/mapLayout';

type Point = [number, number];
const options: WaterfrontUrbanLayoutOptions = { pattern:'waterfront',waterId:'river',bankSide:'both',bankDepth:31,
  waterSetback:2,roadWidth:3,arterialWidth:4,parcelWidth:6,parcelDepth:7,setback:0.8,blockSize:26,seed:41 };
function scene(points: Point[] = [[-15,-67],[-10,-30],[14,4],[8,38],[20,67]], width = 9) {
  const map = createEmptyMap('river settlement','river-settlement',[144,24,144]);
  map.seed = 41;
  map.terrain.heights.fill(2);
  const river: MapWaterBody = { id:'river',name:'River',type:'river',points,width,depth:2,level:0,
    levels:points.map(() => 0),shorelineSmoothness:0.82,shorelineIrregularity:0,shorelineProfile:'gentle' };
  map.waterBodies = [river];
  carveWaterBasinInPlace(map,river);
  return {map,river};
}
function cross(a:Point,b:Point,c:Point) { return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]); }
function distance(p:Point,a:Point,b:Point) {
  const dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(dx*dx+dz*dz||1)));
  return Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dz*t);
}
function intersects(a:Point,b:Point,c:Point,d:Point) {
  return Math.min(distance(a,c,d),distance(b,c,d),distance(c,a,b),distance(d,a,b))<1e-6
    || (cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0);
}
function polygonDistance(a:Point[],b:Point[]) {
  if(a.some(p=>pointInPolygon(p[0],p[1],b))||b.some(p=>pointInPolygon(p[0],p[1],a)))return 0;
  let result=Infinity;
  for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++){
    const p=a[i],q=a[(i+1)%a.length],r=b[j],s=b[(j+1)%b.length];
    if(intersects(p,q,r,s))return 0;
    result=Math.min(result,distance(p,r,s),distance(q,r,s),distance(r,p,q),distance(s,p,q));
  }
  return result;
}
function roadPolygon(a:Point,b:Point,width:number): Point[] {
  const dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz),x=-dz/length*width/2,z=dx/length*width/2;
  return [[a[0]+x,a[1]+z],[a[0]-x,a[1]-z],[b[0]-x,b[1]-z],[b[0]+x,b[1]+z]];
}

function connectedRoads(roads: ReturnType<typeof createWaterfrontUrbanLayout>['roads']) {
  if(!roads.length)return false;
  const reached=new Set([0]),queue=[0];
  for(let index=0;index<queue.length;index++)for(let candidate=0;candidate<roads.length;candidate++){
    if(reached.has(candidate))continue;
    const a=roads[queue[index]].points,b=roads[candidate].points;
    if(a.slice(1).some((end,i)=>b.slice(1).some((other,j)=>intersects(a[i],end,b[j],other)))){
      reached.add(candidate);queue.push(candidate);
    }
  }
  return reached.size===roads.length;
}
describe('river-driven waterfront urban geometry',()=>{
  it('follows the actual curved, carved river on both banks and keeps complete footprints dry and clear',()=>{
    const {map,river}=scene();
    const layout=createWaterfrontUrbanLayout(options,map,river),boundary=waterBoundaryPoints(river),samples=riverPathSamples(river);
    expect(createWaterfrontUrbanLayout(options,map,river)).toEqual(layout);
    expect(createWaterfrontUrbanLayout({...options,seed:42},map,river).parcels).not.toEqual(layout.parcels);
    expect(layout.parcels.filter(p=>p.bank==='left').length).toBeGreaterThan(10);
    expect(layout.parcels.filter(p=>p.bank==='right').length).toBeGreaterThan(10);
    expect(new Set(layout.parcels.map(p=>Math.round(p.rotationY*10))).size).toBeGreaterThan(4);
    for(const bank of ['left','right'])expect(connectedRoads(layout.roads.filter(road=>road.bank===bank))).toBe(true);
    for(const parcel of layout.parcels){
      expect(polygonDistance(parcel.points,boundary)).toBeGreaterThanOrEqual(options.waterSetback!-1e-5);
      const profile=sampleRiverProfile(parcel.center[0],parcel.center[1],samples);
      const sign=profile.direction[0]*(parcel.center[1]-profile.point[1])-profile.direction[1]*(parcel.center[0]-profile.point[0]);
      expect(sign*(parcel.bank==='left'?1:-1)).toBeGreaterThan(0);
      expect(parcel.points.every(([x,z])=>Math.abs(x)<=72&&Math.abs(z)<=72)).toBe(true);
      const toRoad=[parcel.front[0]-parcel.center[0],parcel.front[1]-parcel.center[1]];
      expect(Math.sin(parcel.rotationY)*toRoad[0]+Math.cos(parcel.rotationY)*toRoad[1]).toBeGreaterThan(0);
      for(const road of layout.roads)for(let i=1;i<road.points.length;i++){
        expect(polygonDistance(parcel.points,roadPolygon(road.points[i-1],road.points[i],road.width))).toBeGreaterThanOrEqual(options.setback!-1e-5);
      }
    }
    for(let i=0;i<layout.parcels.length;i++)for(let j=i+1;j<layout.parcels.length;j++)
      expect(polygonDistance(layout.parcels[i].points,layout.parcels[j].points)).toBeGreaterThan(1e-6);
    for(const road of layout.roads)for(let i=1;i<road.points.length;i++){
      expect(polygonDistance(roadPolygon(road.points[i-1],road.points[i],road.width),boundary)).toBeGreaterThanOrEqual(options.waterSetback!-1e-5);
      expect(road.points[i].every(Number.isFinite)).toBe(true);
    }
  });

  it('fits substantial Shanghai frontage into gently bending streets without thinning lots into fragments',()=>{
    const map=createEmptyMap('Shanghai waterfront','shanghai-waterfront',[128,32,128]);
    map.seed=1965915200;
    const points:Point[]=[[-4,-64],[-6,-44],[-2,-23],[4,0],[8,23],[5,44],[1,64]];
    const river:MapWaterBody={id:'huangpu',name:'Huangpu',type:'river',points,width:19,depth:4,level:0.02,
      levels:points.map(()=>0.02),shorelineSmoothness:0.82,shorelineIrregularity:0};
    map.waterBodies=[river];carveWaterBasinInPlace(map,river);
    const settings:WaterfrontUrbanLayoutOptions={id:'shanghai-waterfront',pattern:'waterfront',waterId:river.id,
      bankSide:'both',bankDepth:43,waterSetback:4,roadWidth:3,arterialWidth:5,blockSize:[23,25],
      parcelWidth:8,parcelDepth:9,setback:0.45,irregularity:0.32,seed:map.seed+17};
    const layout=createWaterfrontUrbanLayout(settings,map,river),boundary=waterBoundaryPoints(river);
    expect(layout.parcels.length).toBeGreaterThanOrEqual(58);
    expect(layout.parcels.reduce((area,p)=>area+p.width*p.depth,0)).toBeGreaterThan(3400);
    expect(createWaterfrontUrbanLayout(settings,map,river)).toEqual(layout);
    expect(createWaterfrontUrbanLayout({...settings,seed:map.seed+18},map,river).parcels).not.toEqual(layout.parcels);
    for(const bank of ['left','right']){
      expect(layout.parcels.filter(p=>p.bank===bank).length).toBeGreaterThan(25);
      expect(connectedRoads(layout.roads.filter(road=>road.bank===bank))).toBe(true);
    }
    for(const parcel of layout.parcels){
      expect(parcel.width).toBeGreaterThanOrEqual(8*(1-0.32*0.18)*0.84);
      expect(parcel.depth).toBeGreaterThan(6);
      expect(parcel.points.every(([x,z])=>Math.abs(x)<=64&&Math.abs(z)<=64)).toBe(true);
      expect(polygonDistance(parcel.points,boundary)).toBeGreaterThanOrEqual(settings.waterSetback!-1e-5);
      for(const road of layout.roads)for(let i=1;i<road.points.length;i++){
        expect(polygonDistance(parcel.points,roadPolygon(road.points[i-1],road.points[i],road.width))).toBeGreaterThanOrEqual(settings.setback!-1e-5);
      }
      const toRoad=[parcel.front[0]-parcel.center[0],parcel.front[1]-parcel.center[1]];
      expect(Math.sin(parcel.rotationY)*toRoad[0]+Math.cos(parcel.rotationY)*toRoad[1]).toBeGreaterThan(0);
    }
    for(let i=0;i<layout.parcels.length;i++)for(let j=i+1;j<layout.parcels.length;j++)
      expect(polygonDistance(layout.parcels[i].points,layout.parcels[j].points)).toBeGreaterThan(0.04-1e-6);
  });

  it('moves the bank roads when the declared river bends or its actual widths change',()=>{
    const straight=scene([[0,-67],[0,0],[0,67]],6),wide=scene([[0,-67],[0,0],[0,67]],16);
    const narrowLayout=createWaterfrontUrbanLayout({...options,bankSide:'left'},straight.map,straight.river);
    const wideLayout=createWaterfrontUrbanLayout({...options,bankSide:'left'},wide.map,wide.river);
    const nearestX=(layout: typeof narrowLayout)=>Math.max(...layout.roads.filter(r=>r.kind==='arterial').flatMap(r=>r.points.map(p=>p[0])));
    expect(nearestX(wideLayout)).toBeCloseTo(nearestX(narrowLayout)-5,5);
    const changing=scene([[0,-67],[0,0],[0,67]],6);
    changing.river.widths=[6,18,6];
    carveWaterBasinInPlace(changing.map,changing.river);
    const changingLayout=createWaterfrontUrbanLayout({...options,bankSide:'left'},changing.map,changing.river);
    const shore=changingLayout.roads.filter(r=>r.kind==='arterial').flatMap(r=>r.points);
    expect(Math.min(...shore.map(p=>p[0]))).toBeLessThan(nearestX(narrowLayout)-3);
    expect(createWaterfrontUrbanLayout(options,scene().map,scene().river).roads).not.toEqual(narrowLayout.roads);
  });

  it('honors a single bank and increases rear frontage only when the bank band has room',()=>{
    const {map,river}=scene();
    const shallow=createWaterfrontUrbanLayout({...options,bankSide:'right',bankDepth:16},map,river);
    const deep=createWaterfrontUrbanLayout({...options,bankSide:'right',bankDepth:34},map,river);
    expect(shallow.parcels.length).toBeGreaterThan(3);
    expect(deep.parcels.length).toBeGreaterThan(shallow.parcels.length);
    expect(deep.roads.every(r=>r.bank==='right')).toBe(true);
    expect(deep.parcels.every(p=>p.bank==='right')).toBe(true);
    expect(deep.roads.some(r=>r.kind==='street')).toBe(true);
    for(const parcel of shallow.parcels)for(const point of parcel.points){
      const boundary=waterBoundaryPoints(river);
      expect(Math.min(...boundary.map((a,i)=>distance(point,a,boundary[(i+1)%boundary.length])))).toBeLessThanOrEqual(16+1e-5);
    }
  });

  it('never creates parcel rectangles across another real water body',()=>{
    const {map,river}=scene([[0,-67],[0,67]],8);
    const lake:MapWaterBody={id:'pond',name:'Pond',type:'lake',level:0,depth:1,width:1,
      points:[[-30,-12],[-9,-12],[-9,16],[-30,16]],shorelineSmoothness:0,shorelineIrregularity:0};
    map.waterBodies.push(lake);
    carveWaterBasinInPlace(map,lake);
    const layout=createWaterfrontUrbanLayout(options,map,river);
    expect(layout.parcels.length).toBeGreaterThan(10);
    expect(new Set(layout.roads.map(road=>road.id)).size).toBe(layout.roads.length);
    for(const parcel of layout.parcels)expect(polygonDistance(parcel.points,waterBoundaryPoints(lake))).toBeGreaterThan(0);
  });

  it('makes compact continuous frontages with shared narrow roads rather than closed roads around every plot',()=>{
    const map=createEmptyMap('compact river city','compact-river-city',[160,32,160]);
    map.seed=101;
    const river:MapWaterBody={id:'river',name:'River',type:'river',points:[[-16,-75],[12,-30],[-12,28],[20,75]],
      width:10,depth:2,level:0,levels:[0,0,0,0],shorelineSmoothness:0.82,shorelineProfile:'gentle'};
    map.waterBodies=[river];carveWaterBasinInPlace(map,river);
    const layout=createWaterfrontUrbanLayout({...options,waterSetback:2,roadWidth:2.2,arterialWidth:3.5,
      parcelWidth:6,parcelDepth:8,setback:0.3,bankDepth:38,seed:101},map,river);
    expect(layout.parcels.length).toBeGreaterThan(70);
    expect(layout.roads.every(road=>!road.closed)).toBe(true);
    for(const bank of ['left','right']){
      const roads=layout.roads.filter(road=>road.bank===bank);
      expect(connectedRoads(roads)).toBe(true);
      expect(roads.filter(road=>road.points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p[0]-road.points[i][0],p[1]-road.points[i][1]),0)>100)).toHaveLength(3);
      expect(layout.parcels.filter(parcel=>parcel.bank===bank).length).toBeGreaterThan(30);
    }
  });
  it('fills the outer land of a wide bank band with connected streets and safe edge setbacks',()=>{
    const map=createEmptyMap('whole river city','whole-river-city',[160,32,160]);map.seed=901;
    const points:Point[]=[[0,-76],[-18,-38],[18,5],[6,42],[14,76]];
    const river:MapWaterBody={id:'river',name:'River',type:'river',points,width:10,depth:2.5,level:0.02,
      levels:points.map(()=>0.02),shorelineSmoothness:0.82,shorelineIrregularity:0};
    map.waterBodies=[river];carveWaterBasinInPlace(map,river);
    const settings:WaterfrontUrbanLayoutOptions={...options,bankDepth:80,waterSetback:2,roadWidth:2.2,
      arterialWidth:3.5,parcelWidth:6,parcelDepth:8,setback:0.3,blockSize:38,seed:901};
    const layout=createWaterfrontUrbanLayout(settings,map,river),boundary=waterBoundaryPoints(river);
    expect(layout.parcels.length).toBeGreaterThan(175);
    expect(layout.parcels.filter(p=>p.center[0]<-60).length).toBeGreaterThan(7);
    expect(layout.parcels.filter(p=>p.center[0]>60).length).toBeGreaterThan(7);
    expect(layout.parcels.reduce((area,p)=>area+p.width*p.depth,0)).toBeGreaterThan(7400);
    expect(layout.blocks.length).toBeLessThanOrEqual(128);
    expect(layout.parcels.length).toBeLessThanOrEqual(512);
    for(const bank of ['left','right']){
      const roads=layout.roads.filter(r=>r.bank===bank);
      expect(roads.length).toBeLessThanOrEqual(40);
      expect(connectedRoads(roads)).toBe(true);
      expect(layout.blocks.filter(b=>b.bank===bank).length).toBeLessThanOrEqual(64);
    }
    for(const parcel of layout.parcels){
      expect(parcel.points.every(([x,z])=>Math.abs(x)<=78.5+1e-5&&Math.abs(z)<=78.5+1e-5)).toBe(true);
      expect(polygonDistance(parcel.points,boundary)).toBeGreaterThanOrEqual(settings.waterSetback!-1e-5);
      for(const road of layout.roads)for(let i=1;i<road.points.length;i++)
        expect(polygonDistance(parcel.points,roadPolygon(road.points[i-1],road.points[i],road.width))).toBeGreaterThanOrEqual(settings.setback!-1e-5);
    }
    for(let i=0;i<layout.parcels.length;i++)for(let j=i+1;j<layout.parcels.length;j++)
      expect(polygonDistance(layout.parcels[i].points,layout.parcels[j].points)).toBeGreaterThan(0.04-1e-6);
    for(const road of layout.roads)for(let i=1;i<road.points.length;i++)
      expect(polygonDistance(roadPolygon(road.points[i-1],road.points[i],road.width),boundary)).toBeGreaterThanOrEqual(settings.waterSetback!-1e-5);
  },10000);

  it('connects clipped outer frontage fragments before spending the guide budget on redundant cross streets',()=>{
    const map=createEmptyMap('clipped deep banks','clipped-deep-banks',[160,32,160]);map.terrain.heights.fill(2);
    const points:Point[]=[[0,-76],[-20.5,-40],[22.5,0],[-6.5,40],[10,76]];
    const river:MapWaterBody={id:'river',name:'River',type:'river',points,width:6,widths:[6,8,6,8,6],
      depth:2,level:0,levels:points.map(()=>0),shorelineSmoothness:0.82,shorelineIrregularity:0};
    map.waterBodies=[river];carveWaterBasinInPlace(map,river);
    const layout=createWaterfrontUrbanLayout({...options,bankDepth:80,waterSetback:1.5,roadWidth:2.2,
      arterialWidth:3.5,parcelWidth:5,parcelDepth:7,setback:0.3,blockSize:26,seed:1},map,river);
    for(const bank of ['left','right']){
      const roads=layout.roads.filter(road=>road.bank===bank);
      expect(roads.length).toBeLessThanOrEqual(40);
      expect(connectedRoads(roads)).toBe(true);
      expect(layout.parcels.filter(parcel=>parcel.bank===bank).length).toBeGreaterThan(50);
    }
    const boundary=waterBoundaryPoints(river);
    for(const road of layout.roads)for(let i=1;i<road.points.length;i++)
      expect(polygonDistance(roadPolygon(road.points[i-1],road.points[i],road.width),boundary)).toBeGreaterThanOrEqual(1.5-1e-5);
  },10000);

  it('does not invent dry banks when river water stands above the actual terrain',()=>{
    const {map,river}=scene([[0,-67],[0,67]],10);
    river.level=0.2;river.levels=[0.2,0.2];
    map.terrain.heights.fill(0);carveWaterBasinInPlace(map,river);
    const submergedBanks=createWaterfrontUrbanLayout(options,map,river);
    expect(submergedBanks.roads).toEqual([]);
    expect(submergedBanks.parcels).toEqual([]);
    map.terrain.heights.fill(0.5);carveWaterBasinInPlace(map,river);
    const dryBanks=createWaterfrontUrbanLayout(options,map,river);
    expect(dryBanks.parcels.filter(parcel=>parcel.bank==='left').length).toBeGreaterThan(8);
    expect(dryBanks.parcels.filter(parcel=>parcel.bank==='right').length).toBeGreaterThan(8);
  });
  it('rejects missing, non-river and malformed inputs and bounds very long river work',()=>{
    const {map,river}=scene();
    expect(()=>createWaterfrontUrbanLayout(options,map,undefined as never)).toThrow('invalid_waterfront');
    expect(()=>createWaterfrontUrbanLayout(options,map,{...river,type:'lake'})).toThrow('invalid_waterfront');
    expect(()=>createWaterfrontUrbanLayout({...options,waterId:'missing'},map,river)).toThrow('invalid_waterfront');
    expect(()=>createWaterfrontUrbanLayout({...options,bankDepth:Infinity},map,river)).toThrow('invalid_waterfront');
    const large=createEmptyMap('long','long',[10000,30,10000]);
    large.terrain.heights.fill(2);
    const longRiver={...river,points:[[0,-5000],[0,5000]] as Point[]};large.waterBodies=[longRiver];
    const layout=createWaterfrontUrbanLayout({...options,parcelWidth:0.1,blockSize:0.1,bankDepth:1000},large,longRiver);
    expect(layout.roads.length).toBeLessThanOrEqual(80);
    expect(layout.blocks.length).toBeLessThanOrEqual(128);
    expect(layout.parcels.length).toBeLessThanOrEqual(512);
    for(const bank of ['left','right']){
      expect(layout.roads.filter(road=>road.bank===bank).length).toBeLessThanOrEqual(40);
      expect(connectedRoads(layout.roads.filter(road=>road.bank===bank))).toBe(true);
    }
  });
});
