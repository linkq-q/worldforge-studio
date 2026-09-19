// [M04b] Continuous density field replaces overlapping circle silhouettes.
// This is a procedural painted sky texture, not a volumetric cloud simulation.
export function paintCloudField(ctx,w,h){
 const n=(x,y)=>{let k=Math.imul(x,374761393)+Math.imul(y,668265263);k=Math.imul(k^(k>>>13),1274126177);return ((k^(k>>>16))>>>0)/4294967295;};
 const noise=(x,y)=>{const ix=Math.floor(x),iy=Math.floor(y);let fx=x-ix,fy=y-iy;fx=fx*fx*(3-2*fx);fy=fy*fy*(3-2*fy);return (n(ix,iy)*(1-fx)+n(ix+1,iy)*fx)*(1-fy)+(n(ix,iy+1)*(1-fx)+n(ix+1,iy+1)*fx)*fy;};
 const fbm=(x,y)=>noise(x,y)*.53+noise(x*2.03+7,y*2.03+11)*.27+noise(x*4.09+19,y*4.09)*.13+noise(x*8.17,y*8.17+31)*.07;
 const cloudCanvas=document.createElement('canvas');cloudCanvas.width=w;cloudCanvas.height=h;const cc=cloudCanvas.getContext('2d'),image=cc.createImageData(w,h),data=image.data;
 const lobes=[[.925,.14,.14,.23],[.835,.30,.12,.15],[.755,.41,.1,.085],[.42,.385,.14,.082],[.29,.28,.06,.16],[.56,.47,.18,.045],[.16,.43,.1,.055]];
 const density=new Float32Array(w*h);
 for(let y=0;y<h*.66;y++){const v=y/h;for(let x=0;x<w;x++){const u=x/w;let envelope=0;for(const [cx,cy,rx,ry] of lobes){const r=((u-cx)/rx)**2+((v-cy)/ry)**2;envelope=Math.max(envelope,Math.max(0,1-r*.65));}
  const detail=fbm(u*36,v*27),broad=noise(u*13+5,v*16+8);
  let d=envelope*.91+detail*.75+broad*.29-.79;
  // Upper fragmented cirrus stretches away from the solar convergence point.
  if(v<.36){const rx=u-.57,ry=v-.56,angle=Math.atan2(ry,rx),radius=Math.hypot(rx,ry);const wisps=fbm(angle*25+30,radius*100);d=Math.max(d,(wisps-.67)*1.25+(noise(u*9,v*15)-.5)*.15);}
  if(v>.48)d=Math.max(d,(fbm(u*25,v*180)-.72)*.7);
  density[y*w+x]=d;
 }}
 for(let y=0;y<h*.66;y++)for(let x=0;x<w;x++){const idx=y*w+x,d=density[idx];if(d<=0)continue;const u=x/w,v=y/h,edge=Math.max(0,1-d/.075),sx=Math.sign(.57-u),sy=Math.sign(.56-v);const xx=Math.min(w-1,Math.max(0,x+Math.round(sx*5))),yy=Math.min(h-1,y+Math.round(sy*5));const toward=density[yy*w+xx];const rim=Math.min(1,Math.max(0,(d-toward)*16)+edge*.32);const warm=Math.min(1,Math.max(0,(v-.12)*2.5));const texture=fbm(u*95+2,v*100)*20;const shade=Math.min(1,d*1.25);
  const base=[150+warm*64-shade*35+texture,157-warm*22-shade*33+texture,192-warm*48-shade*25+texture];const edgeColor=[255,219+warm*20,166+warm*7];const p=idx*4;for(let c=0;c<3;c++)data[p+c]=base[c]*(1-rim)+edgeColor[c]*rim;data[p+3]=Math.min(255,d*6000);
 }
 cc.putImageData(image,0,0);ctx.drawImage(cloudCanvas,0,0);
}
