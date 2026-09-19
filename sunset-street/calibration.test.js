import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {FRAME,focal,onGround,atDepth,project,landmarks,groundY} from './calibration.js';

test('ground anchors obey the world slope and reproject to the measured pixels',()=>{
 for(const uv of [landmarks.leftPoleFoot,landmarks.rightPoleFoot,[590,940],[1000,720]]){
  const xyz=onGround(...uv);assert.ok(xyz[2]<0);assert.ok(Math.abs(xyz[1]-groundY(xyz[2]))<1e-10);
  const actual=project(xyz);assert.ok(Math.hypot(actual[0]-uv[0],actual[1]-uv[1])<1e-9);
 }
 assert.throws(()=>onGround(950,550),RangeError);
});
test('Three.js projection independently agrees with calibrated image coordinates',()=>{
 const camera=new THREE.PerspectiveCamera(FRAME.fov,FRAME.width/FRAME.height,.08,2400);
 camera.position.set(0,FRAME.cameraHeight,0);
 camera.setViewOffset(FRAME.width,FRAME.height,FRAME.width/2-FRAME.cx,FRAME.height/2-FRAME.cy,FRAME.width,FRAME.height);
 camera.updateMatrixWorld();
 for(const uv of [[0,0],[1672,941],landmarks.sun,landmarks.signal,landmarks.roadSign]){
  const point=new THREE.Vector3(...atDepth(...uv,40)).project(camera);
  const px=(point.x+1)*FRAME.width/2,py=(1-point.y)*FRAME.height/2;
  assert.ok(Math.hypot(px-uv[0],py-uv[1])<1e-8);
 }
 assert.ok(Math.abs(focal-964.667957)<.000001);
});
