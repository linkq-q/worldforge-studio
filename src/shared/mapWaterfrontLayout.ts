import { getMapBounds, sampleTerrainHeight, type EditableMap, type MapWaterBody } from './map';
import { sampleMapGuide } from './mapGuide';
import { pointInPolygon } from './mapLayout';
import { riverEdgePairs, riverPathSamples, sampleRiverProfile, waterBoundaryPoints } from './mapWater';
import { terrainSlopeDegrees } from './mapTerrainAnalysis';
import type { UrbanBlock, UrbanLayoutOptions, UrbanParcel, UrbanPoint, UrbanRoad } from './mapUrbanLayout';

type Bank = 'left' | 'right';
export interface WaterfrontUrbanLayoutOptions extends Omit<UrbanLayoutOptions, 'pattern' | 'center' | 'size' | 'rotation' | 'region' | 'rings' | 'spokes'> {
  pattern?: 'waterfront';
  waterId: string;
  bankSide?: 'both' | Bank;
  /** Maximum horizontal distance from the actual water boundary into land. */
  bankDepth?: number;
  /** Minimum clearance from the water polygon to the road surface or building. */
  waterSetback?: number;
}
export interface WaterfrontUrbanLayout {
  roads: Array<UrbanRoad & { bank: Bank }>;
  blocks: Array<UrbanBlock & { bank: Bank }>;
  parcels: Array<UrbanParcel & { bank: Bank }>;
}
type FrontageRoad = { road: WaterfrontUrbanLayout['roads'][number]; row: number; offset: number };
const EPS = 1e-7;

/** Pure river-bank geometry. Cross-river bridges and terrain grading remain scene operations. */
export function createWaterfrontUrbanLayout(options: WaterfrontUrbanLayoutOptions, map: EditableMap, water: MapWaterBody): WaterfrontUrbanLayout {
  if (!options || !water || water.type !== 'river' || !options.waterId || options.waterId !== water.id
    || !map.waterBodies.some(candidate => candidate.id === water.id) || water.points.length < 2
    || !water.points.every(p => p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6))
    || !Number.isFinite(water.width) || water.width <= 0
    || water.widths?.some(width => !Number.isFinite(width) || width <= 0)) throw new Error('invalid_waterfront_river');
  if (options.pattern !== undefined && options.pattern !== 'waterfront') throw new Error('invalid_waterfront_pattern');
  for (const key of ['center','size','rotation','region','rings','spokes']) {
    if (key in options) throw new Error(`invalid_waterfront_site_override:${key}`);
  }
  const bankSide = options.bankSide ?? 'both';
  if (!['left','right','both'].includes(bankSide)) throw new Error('invalid_waterfront_bank_side');
  const sides: Bank[] = bankSide === 'both' ? ['left','right'] : [bankSide];
  const bankDepth = number(options.bankDepth, 32, 0.1);
  const waterSetback = number(options.waterSetback, 2.5, 0);
  const roadWidth = number(options.roadWidth, 3, 0.1);
  const arterialWidth = Math.max(roadWidth, number(options.arterialWidth, roadWidth * 1.5, 0.1));
  const parcelWidth = number(options.parcelWidth, 6, 0.1);
  const parcelDepth = number(options.parcelDepth, 7, 0.3);
  const setback = number(options.setback, 0.8, 0);
  const blockSize = number(Array.isArray(options.blockSize) ? options.blockSize[0] : options.blockSize, 26, 0.1);
  const irregularity = Math.min(1, number(options.irregularity, 0.35, 0));
  const random = seededRandom(number(options.seed, map.seed, 0, Number.MAX_SAFE_INTEGER));
  const bounds = getMapBounds(map);
  const mapWidth=bounds.maxX-bounds.minX,mapDepth=bounds.maxZ-bounds.minZ;
  const edgeMargin=Math.min(1.5,Math.min(mapWidth,mapDepth)/20);
  const bankRoadLimit=Math.floor(80/sides.length);
  const bankBlockLimit=Math.floor(Math.min(128,Math.max(sides.length,Math.ceil(mapWidth*mapDepth/200)))/sides.length);
  const rowLimit=Math.min(12,Math.ceil(Math.min(bankDepth,Math.hypot(mapWidth,mapDepth))/(parcelDepth+2*setback+roadWidth)));
  const prefix = typeof options.id === 'string' ? options.id.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,40) || 'waterfront' : 'waterfront';
  const result: WaterfrontUrbanLayout = { roads:[],blocks:[],parcels:[] };
  const samples = riverPathSamples(water), edges = riverEdgePairs(water);
  if (samples.length < 2) throw new Error('invalid_waterfront_river');
  const waters = map.waterBodies.map(body => ({ body, points: body.type === 'ocean' ? [] : waterBoundaryPoints(body) }));
  const riverBoundary = waters.find(entry => entry.body.id === water.id)!.points;
  const inBounds = (p: UrbanPoint, margin = 0) => p[0] >= bounds.minX + edgeMargin + margin - EPS && p[0] <= bounds.maxX - edgeMargin - margin + EPS
    && p[1] >= bounds.minZ + edgeMargin + margin - EPS && p[1] <= bounds.maxZ - edgeMargin - margin + EPS;
  const bankPoint = (p: UrbanPoint, bank: Bank, depth = bankDepth): boolean => {
    const profile = sampleRiverProfile(p[0],p[1],samples);
    const side = profile.direction[0] * (p[1]-profile.point[1]) - profile.direction[1] * (p[0]-profile.point[0]);
    return side * (bank === 'left' ? 1 : -1) > EPS
      && boundaryDistance(p,riverBoundary) <= depth + 1e-5
      && sampleTerrainHeight(map,p[0],p[1]) >= profile.level - 0.1;
  };
  const roadSafe = (a: UrbanPoint,b: UrbanPoint,width:number,bank:Bank): boolean => {
    const probes = [a,b,mix(a,b,0.5)];
    if (!probes.every(p => inBounds(p,width/2) && bankPoint(p,bank,bankDepth-width/2))) return false;
    return waters.every(({body,points}) => body.type === 'ocean'
      ? probes.every(p => sampleTerrainHeight(map,p[0],p[1]) > body.level + 0.05)
      : segmentPolygonDistance(a,b,points) >= width/2 + (body.id === water.id ? waterSetback : 0.05) - 1e-5);
  };
  const frontage: FrontageRoad[] = [];
  let roadSerial=0;
  const addRoad = (points: UrbanPoint[],width:number,bank:Bank,kind:UrbanRoad['kind'],row?:number,offset=0): void => {
    const count=result.roads.filter(road=>road.bank===bank).length;
    // Reserve enough guides to connect every frontage run before spending on extra cross streets.
    if (points.length < 2 || count >= (row===undefined?bankRoadLimit:Math.floor(bankRoadLimit/2))) return;
    const road = {id:`${prefix}-${bank}-road-${++roadSerial}`,points,width,bank,kind,closed:false};
    result.roads.push(road);
    if (row !== undefined) frontage.push({road,row,offset});
  };
  const addBankRun = (points:UrbanPoint[],width:number,bank:Bank,row:number,offset:number):void => {
    let run:UrbanPoint[]=[];
    const flush=()=>{ if(run.length>1)addRoad(run,width,bank,row===0?'arterial':'street',row,offset);run=[]; };
    for(let index=1;index<points.length;index++){
      const segment=clipBounds(points[index-1],points[index],bounds,edgeMargin+width/2+0.001);
      if(!segment||!roadSafe(segment[0],segment[1],width,bank)){flush();continue;}
      if(run.length&&length(sub(run.at(-1)!,segment[0]))>1e-5)flush();
      if(!run.length)run.push(segment[0]);run.push(segment[1]);
    }
    flush();
  };
  for(const bank of sides){
    const shore=edges.map(edge=>edge[bank]);
    let offset=waterSetback+arterialWidth/2+0.03;
    for(let row=0;row<rowLimit;row++){
      const width=row===0?arterialWidth:roadWidth;
      if(offset+width/2+setback+Math.min(parcelDepth,2)>bankDepth)break;
      addBankRun(offsetBank(shore,offset,bank),width,bank,row,offset);
      offset+=width/2+setback+parcelDepth+setback+roadWidth/2;
    }
    const bankRoads=frontage.filter(entry=>entry.road.bank===bank);
    const length=pathLength(shore);
    const spacing=Math.max(blockSize,length/12);
    const stations=sample(shore,spacing,spacing*(0.22+random()*0.3),spacing*0.3);
    const crossStreets:Array<[UrbanPoint,UrbanPoint]>=[];
    for(let row=1;row<rowLimit;row++){
      const previous=bankRoads.filter(entry=>entry.row===row-1),next=bankRoads.filter(entry=>entry.row===row);
      if(!previous.length||!next.length)continue;
      let connected=false;
      for(const station of stations){
        const sign=bank==='left'?1:-1,normal:UrbanPoint=[-station.tangentZ*sign,station.tangentX*sign];
        const p:UrbanPoint=[station.x,station.z];
        const near=nearestRoad(add(p,scale(normal,previous[0].offset)),previous);
        const far=nearestRoad(add(p,scale(normal,next[0].offset)),next);
        if(!near||!far||near.distance>2||far.distance>2)continue;
        if(!roadSafe(near.point,far.point,roadWidth,bank))continue;
        if(!connected){addRoad([near.point,far.point],roadWidth,bank,'street');connected=true;}
        else crossStreets.push([near.point,far.point]);
      }
    }
    let bankRoadsConnected=result.roads.filter(road=>road.bank===bank);
    let reached=connectedRoadIds(bankRoadsConnected);
    // Clipping can leave short outer frontage runs between the usual cross-street stations.
    // Join the nearest safe runs before spending the remaining budget on extra intersections.
    while(reached.size<bankRoadsConnected.length&&bankRoadsConnected.length<bankRoadLimit){
      let link:{a:UrbanPoint;b:UrbanPoint;distance:number}|null=null;
      const consider=(a:UrbanPoint,b:UrbanPoint)=>{
        const distance=Math.hypot(a[0]-b[0],a[1]-b[1]);
        if(distance>3*(parcelDepth+2*setback+roadWidth)||distance>=(link?.distance??Infinity))return;
        if(roadSafe(a,b,roadWidth,bank))link={a,b,distance};
      };
      for(const outer of bankRoadsConnected.filter(road=>!reached.has(road.id)))
        for(const inner of bankRoadsConnected.filter(road=>reached.has(road.id))){
          for(const point of outer.points)for(let i=1;i<inner.points.length;i++)consider(point,nearest(point,inner.points[i-1],inner.points[i]));
          for(const point of inner.points)for(let i=1;i<outer.points.length;i++)consider(nearest(point,outer.points[i-1],outer.points[i]),point);
        }
      if(!link)break;
      const connection=link as {a:UrbanPoint;b:UrbanPoint};
      addRoad([connection.a,connection.b],roadWidth,bank,'street');
      bankRoadsConnected=result.roads.filter(road=>road.bank===bank);
      reached=connectedRoadIds(bankRoadsConnected);
    }
    // A disconnected island behind an obstacle cannot supply accessible building frontage.
    result.roads=result.roads.filter(road=>road.bank!==bank||reached.has(road.id));
    for(let index=frontage.length-1;index>=0;index--)if(frontage[index].road.bank===bank&&!reached.has(frontage[index].road.id))frontage.splice(index,1);
    const retained=result.roads.filter(road=>road.bank===bank);
    for(const points of crossStreets)if(points.every(point=>retained.some(road=>road.points.slice(1).some((end,index)=>distance(point,road.points[index],end)<1e-5))))
      addRoad(points,roadWidth,bank,'street');
  }
  const roadSegments=result.roads.flatMap(road=>road.points.slice(1).map((b,i)=>({a:road.points[i],b,width:road.width})));
  const safeFootprint=(points:UrbanPoint[],bank:Bank,terrain=true):boolean=>{
    const probes=[...points,...points.map((p,i)=>mix(p,points[(i+1)%points.length],0.5)),average(points)];
    if(!probes.every(p=>inBounds(p)&&bankPoint(p,bank)&&(!terrain||terrainSlopeDegrees(map,p[0],p[1])<=35)))return false;
    if(!waters.every(({body,points:boundary})=>body.type==='ocean'
      ? probes.every(p=>sampleTerrainHeight(map,p[0],p[1])>body.level+0.05)
      : polygonDistance(points,boundary)>=(body.id===water.id?waterSetback:0.05)-1e-5))return false;
    return roadSegments.every(segment=>segmentPolygonDistance(segment.a,segment.b,points)>=segment.width/2+setback-1e-5);
  };
  const groups=new Map<string,WaterfrontUrbanLayout['blocks'][number]>();
  for(const bank of sides){
    let bankParcelCount=0,bankBlockCount=0;
    const candidates=frontage.filter(entry=>entry.road.bank===bank).flatMap(entry=>{
      const {road}=entry,total=pathLength(road.points),spacing=Math.max(parcelWidth*1.12,total/96);
      return sample(road.points,spacing,spacing*0.55,spacing*0.55).map(station=>({entry,road,total,spacing,station}));
    });
    // Distribute a finite block budget across all street rows rather than starving the outer city.
    if(new Set(candidates.map(candidate=>candidate.entry.row)).size>3)candidates.sort((a,b)=>a.station.distance/a.total-b.station.distance/b.total);
    for(const {entry,road,total,spacing,station} of candidates){
      if(bankParcelCount>=Math.floor(512/sides.length))break;
      const baseWidth=parcelWidth*(1-irregularity*0.18+random()*irregularity*0.14);
      const baseDepth=Math.min(parcelDepth*(0.9+random()*0.1),bankDepth-entry.offset-road.width/2-setback-0.1);
      const key=`${road.id}:${Math.floor(station.distance/Math.max(blockSize,spacing))}`;
      if(baseDepth<1||(bankBlockCount>=bankBlockLimit&&!groups.has(key)))continue;
      // At bends, try nearby frontage and modestly smaller complete rectangles before abandoning a lot.
      // Three sizes, three along-road positions and four normal offsets bound the search to 36 checks.
      attempts:for(const fit of [1,0.92,0.84])for(const slide of [0,0.2,-0.2]){
        const width=baseWidth*fit,depth=baseDepth*fit;
        if(total<width||depth<1)continue;
        const distance=Math.max(width/2,Math.min(total-width/2,station.distance+slide*parcelWidth));
        const shifted=sample(road.points,total+1,distance,total-distance)[0];
        const sign=bank==='left'?1:-1,tangent:UrbanPoint=[shifted.tangentX,shifted.tangentZ],normal:UrbanPoint=[-tangent[1]*sign,tangent[0]*sign];
        const front:UrbanPoint=[shifted.x,shifted.z];
        for(const extra of [0.04,0.4,0.9,1.5]){
          const center=add(front,scale(normal,road.width/2+setback+depth/2+extra));
          const points=rectangleAt(center,tangent,normal,width,depth);
          if(!safeFootprint(points,bank)||result.parcels.some(parcel=>polygonDistance(points,parcel.points)<=0.04))continue;
          let block=groups.get(key);
          if(block){
            const hull=convexHull([...block.points,...points]);
            if(safeFootprint(hull,bank,false)&&!result.blocks.some(other=>other!==block&&polygonDistance(hull,other.points)<=EPS)){
              block.points=hull;block.center=average(hull);
            }else block=undefined;
          }
          if(!block){
            if(bankBlockCount>=bankBlockLimit)break;
            block={id:`${prefix}-${bank}-block-${result.blocks.length+1}`,points,center,bank};
            result.blocks.push(block);bankBlockCount++;groups.set(key,block);
          }
          result.parcels.push({id:`${prefix}-${bank}-parcel-${result.parcels.length+1}`,blockId:block.id,roadId:road.id,
            center,width,depth,rotationY:Math.atan2(-normal[0],-normal[1]),front,points,bank});
          bankParcelCount++;break attempts;
        }
      }
    }
  }
  return result;
}

function number(value:unknown,fallback:number,min:number,max=1e6):number {
  const result=value===undefined?fallback:value;
  if(typeof result!=='number'||!Number.isFinite(result)||result<min||result>max)throw new Error('invalid_waterfront_number');
  return result;
}
function add(a:UrbanPoint,b:UrbanPoint):UrbanPoint{return[a[0]+b[0],a[1]+b[1]];}
function sub(a:UrbanPoint,b:UrbanPoint):UrbanPoint{return[a[0]-b[0],a[1]-b[1]];}
function scale(a:UrbanPoint,s:number):UrbanPoint{return[a[0]*s,a[1]*s];}
function mix(a:UrbanPoint,b:UrbanPoint,t:number):UrbanPoint{return add(a,scale(sub(b,a),t));}
function length(p:UrbanPoint):number{return Math.hypot(p[0],p[1]);}
function average(points:UrbanPoint[]):UrbanPoint{return scale(points.reduce(add,[0,0]),1/points.length);}
function cross(a:UrbanPoint,b:UrbanPoint,c:UrbanPoint):number{return(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
function nearest(p:UrbanPoint,a:UrbanPoint,b:UrbanPoint):UrbanPoint{
  const d=sub(b,a),t=Math.max(0,Math.min(1,((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1])/(d[0]*d[0]+d[1]*d[1]||1)));
  return add(a,scale(d,t));
}
function distance(p:UrbanPoint,a:UrbanPoint,b:UrbanPoint):number{return length(sub(p,nearest(p,a,b)));}
function boundaryDistance(p:UrbanPoint,points:UrbanPoint[]):number{return Math.min(...points.map((a,i)=>distance(p,a,points[(i+1)%points.length])));}
function intersects(a:UrbanPoint,b:UrbanPoint,c:UrbanPoint,d:UrbanPoint):boolean{
  return Math.min(distance(a,c,d),distance(b,c,d),distance(c,a,b),distance(d,a,b))<EPS
    ||cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0;
}
function segmentPolygonDistance(a:UrbanPoint,b:UrbanPoint,points:UrbanPoint[]):number{
  if(pointInPolygon(a[0],a[1],points)||pointInPolygon(b[0],b[1],points))return 0;
  let result=Infinity;
  for(let i=0;i<points.length;i++){
    const p=points[i],q=points[(i+1)%points.length];if(intersects(a,b,p,q))return 0;
    result=Math.min(result,distance(a,p,q),distance(b,p,q),distance(p,a,b),distance(q,a,b));
  }
  return result;
}
function polygonDistance(a:UrbanPoint[],b:UrbanPoint[]):number{
  if(b.some(p=>pointInPolygon(p[0],p[1],a)))return 0;
  return Math.min(...a.map((p,i)=>segmentPolygonDistance(p,a[(i+1)%a.length],b)));
}
function pathLength(points:UrbanPoint[]):number{return points.slice(1).reduce((sum,p,i)=>sum+length(sub(p,points[i])),0);}
function sample(points:UrbanPoint[],spacing:number,startOffset:number,endOffset:number){
  return sampleMapGuide({id:'bank',name:'bank',points,curve:'polyline',closed:false,width:1,tags:[]},{spacing,startOffset,endOffset});
}
function offsetBank(points:UrbanPoint[],offset:number,bank:Bank):UrbanPoint[]{
  const sign=bank==='left'?1:-1;
  return points.map((point,index)=>{
    const before=sub(point,points[Math.max(0,index-1)]),after=sub(points[Math.min(points.length-1,index+1)],point);
    const a=length(before)>EPS?before:after,b=length(after)>EPS?after:before;
    const n1:UrbanPoint=[-a[1]/length(a)*sign,a[0]/length(a)*sign],n2:UrbanPoint=[-b[1]/length(b)*sign,b[0]/length(b)*sign];
    const normal=add(n1,n2),denominator=1+n1[0]*n2[0]+n1[1]*n2[1];
    const shift=denominator>0.1?scale(normal,offset/denominator):scale(n2,offset);
    return add(point,length(shift)>offset*3?scale(shift,offset*3/length(shift)):shift);
  });
}
function connectedRoadIds(roads:UrbanRoad[]):Set<string>{
  if(!roads.length)return new Set();
  const reached=new Set([roads[0].id]),queue=[roads[0]];
  for(let index=0;index<queue.length;index++)for(const road of roads){
    if(reached.has(road.id))continue;
    if(queue[index].points.slice(1).some((a,i)=>road.points.slice(1).some((b,j)=>intersects(queue[index].points[i],a,road.points[j],b)))){
      reached.add(road.id);queue.push(road);
    }
  }
  return reached;
}
function nearestRoad(point:UrbanPoint,roads:FrontageRoad[]):{point:UrbanPoint;distance:number}|null{
  let best:{point:UrbanPoint;distance:number}|null=null;
  for(const {road}of roads)for(let i=1;i<road.points.length;i++){
    const projected=nearest(point,road.points[i-1],road.points[i]),distance=length(sub(point,projected));
    if(!best||distance<best.distance)best={point:projected,distance};
  }
  return best;
}
function rectangleAt(center:UrbanPoint,tangent:UrbanPoint,normal:UrbanPoint,width:number,depth:number):UrbanPoint[]{
  const points=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,z])=>add(center,add(scale(tangent,x*width/2),scale(normal,z*depth/2))));
  if(cross(points[0],points[1],points[2])<0)points.reverse();return points;
}
function convexHull(points:UrbanPoint[]):UrbanPoint[]{
  const sorted=[...points].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const half=(list:UrbanPoint[])=>{const hull:UrbanPoint[]=[];for(const p of list){while(hull.length>=2&&cross(hull[hull.length-2],hull[hull.length-1],p)<=EPS)hull.pop();hull.push(p);}return hull;};
  const lower=half(sorted),upper=half([...sorted].reverse());lower.pop();upper.pop();return[...lower,...upper];
}
function clipBounds(a:UrbanPoint,b:UrbanPoint,bounds:ReturnType<typeof getMapBounds>,margin:number):[UrbanPoint,UrbanPoint]|null{
  let low=0,high=1;const d=sub(b,a);
  for(const [axis,min,max]of [[0,bounds.minX+margin,bounds.maxX-margin],[1,bounds.minZ+margin,bounds.maxZ-margin]]){
    if(Math.abs(d[axis])<EPS){if(a[axis]<min||a[axis]>max)return null;continue;}
    const first=(min-a[axis])/d[axis],last=(max-a[axis])/d[axis];low=Math.max(low,Math.min(first,last));high=Math.min(high,Math.max(first,last));
  }
  return high-low>EPS?[mix(a,b,low),mix(a,b,high)]:null;
}
function seededRandom(seed:number):()=>number{
  let state=Math.trunc(seed)>>>0;return()=>{state+=0x6D2B79F5;let value=Math.imul(state^state>>>15,state|1);value^=value+Math.imul(value^value>>>7,value|61);return((value^value>>>14)>>>0)/4294967296;};
}
