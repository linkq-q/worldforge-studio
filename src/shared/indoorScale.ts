import {
  getMapPlayerMetrics,
  worldScaleProfileMultiplier,
  type EditableMap
} from './map';

export interface IndoorSemanticDimensions {
  targetHeight: number | null;
  minimumWidth: number;
  minimumDepth: number;
  maximumWidth: number | null;
  maximumDepth: number | null;
  maximumHeight: number | null;
  wallMounted: boolean;
  ceilingMounted: boolean;
}

/** Character-relative cartoon proportions shared by compilation and lint repair. */
export function indoorSemanticDimensions(map: EditableMap, semantic: string): IndoorSemanticDimensions {
  const { height, radius } = getMapPlayerMetrics(map);
  const profile = worldScaleProfileMultiplier(map.worldScaleProfile);
  const cartoon = 1.2 * profile;
  const usableHeight = Math.max(0.5, (map.room?.size[1] ?? map.box.size[1]) - (map.room?.wallThickness ?? 0) * 2);
  const wallMounted = isElevatedWallSemantic(semantic);
  const ceilingMounted = isCeilingMountedSemantic(semantic);
  const cap = (value: number, ratio = 0.88) => Math.min(value, usableHeight * ratio);
  const dimensions = (
    targetHeight: number | null,
    minimumWidth: number,
    minimumDepth: number,
    maximumWidth: number | null = null,
    maximumDepth: number | null = null,
    maximumHeight: number | null = null
  ): IndoorSemanticDimensions => ({
    targetHeight, minimumWidth, minimumDepth, maximumWidth, maximumDepth, maximumHeight,
    wallMounted, ceilingMounted
  });

  if (/\brug\b|carpet|floor[-_ ]?textile|woven[-_ ]?rug|地毯|脚垫/i.test(semantic)) {
    return dimensions(height * 0.035, 0, 0, (map.room?.size[0] ?? 8) * 0.72, (map.room?.size[2] ?? 8) * 0.72, height * 0.09);
  }

  if (/loading door|loading bay|warehouse door|装卸门|仓库门/i.test(semantic)) {
    return dimensions(cap(height * 1.45, 0.92), height * 1.6, 0);
  }
  if (/\bdoor\b|房门|门扇/i.test(semantic)) {
    return dimensions(cap(height * 1.35, 0.92), height * 0.72, 0);
  }
  if (/blackboard|chalkboard|whiteboard|teaching surface|notice board|menu board|黑板|白板|公告板|菜单板/i.test(semantic)) {
    return dimensions(cap(height * 0.78, 0.7), height * 1.75, 0);
  }
  if (/\bwindow\b|窗户|窗框/i.test(semantic)) {
    return dimensions(cap(height * 0.9, 0.74), height * 1.05, 0);
  }
  if (/ceiling[-_ ]?light|ceiling[-_ ]?lamp|overhead[-_ ]?light|pendant[-_ ]?light|industrial[-_ ]?light|顶灯|吊灯|天花灯|工业照明/i.test(semantic)) {
    return dimensions(cap(height * 0.18, 0.2), height * 0.65, height * 0.18);
  }
  if (/safety sign|warning sign|warehouse sign|room[-_ ]?(?:number|sign)|door[-_ ]?sign|nameplate|门牌|房号|安全标识|警示牌/i.test(semantic)) {
    return dimensions(cap(height * 0.3, 0.42), height * 0.42, 0, height * 0.9, height * 0.9, height * 0.62);
  }
  if (/wall[-_ ]?clock|timepiece|挂钟|时钟/i.test(semantic)) {
    return dimensions(cap(height * 0.36, 0.38), height * 0.36, 0);
  }
  if (/fire extinguisher|灭火器/i.test(semantic)) {
    return dimensions(cap(height * 0.62, 0.62), height * 0.22, height * 0.18);
  }
  if (/crate|shipping box|carton|cargo box|storage box|木箱|货箱|运输箱|纸箱/i.test(semantic)) {
    return dimensions(cap(height * 0.42, 0.42), height * 0.5, height * 0.45);
  }
  if (/loaded pallet|wood pallet|cargo pallet|\bpallet\b|托盘|栈板/i.test(semantic)) {
    return dimensions(cap(height * 0.22, 0.28), height * 0.7, height * 0.55);
  }
  if (/pallet jack|warehouse cart|trolley|hand truck|搬运车|手推车|推车/i.test(semantic)) {
    return dimensions(cap(height * 0.48, 0.48), height * 0.5, height * 0.65);
  }
  if (/aisle marker|marker post|bollard|通道标识柱|标识柱/i.test(semantic)) {
    return dimensions(cap(height * 0.75, 0.72), height * 0.35, height * 0.3);
  }
  if (/chair|seat|pew|stool|armchair|椅|座椅|长凳|扶手椅/i.test(semantic)) {
    return dimensions(
      cap(height * 0.64 * cartoon, 0.54),
      Math.max(radius * 1.8, height * 0.42 * cartoon),
      height * 0.36 * cartoon
    );
  }
  if (/service counter|cashier|checkout|reception|counter|收银台|服务台|前台|柜台/i.test(semantic)) {
    return dimensions(cap(height * 0.68 * cartoon, 0.56), height * 1.15 * cartoon, height * 0.5 * cartoon);
  }
  if (/table|desk|workstation|餐桌|书桌|课桌|办公桌|工位|会议桌/i.test(semantic)) {
    return dimensions(cap(height * 0.58 * cartoon, 0.5), height * 0.82 * cartoon, height * 0.55 * cartoon);
  }
  if (/bookcase|bookshelf|wardrobe|cabinet|storage rack|shelf|书柜|书架|衣柜|储物柜|文件柜|货架/i.test(semantic)) {
    return dimensions(
      cap(height * 1.18 * cartoon, 0.88),
      Math.max(radius * 2.4, height * 0.72 * cartoon),
      height * 0.3 * cartoon
    );
  }
  if (/\bbed\b|床铺|双人床|单人床/i.test(semantic)) {
    return dimensions(cap(height * 0.62 * cartoon, 0.5), height * 1.1 * cartoon, height * 1.5 * cartoon);
  }
  if (/lectern|pulpit|altar|podium|讲台|祭坛/i.test(semantic)) {
    return dimensions(cap(height * 0.88 * cartoon, 0.64), height * 0.65 * cartoon, height * 0.42 * cartoon);
  }
  return dimensions(null, 0, 0);
}

export function isElevatedWallSemantic(semantic: string): boolean {
  return /wall-mounted|wall-prop|wall[-_ ]?(?:art|decor)|framed[-_ ]?art|sconce|cross|window|blackboard|chalkboard|whiteboard|notice board|menu board|wall[-_ ]?clock|timepiece|poster|painting|safety sign|warning sign|room[-_ ]?(?:number|sign)|door[-_ ]?sign|nameplate|fire extinguisher|门牌|房号|壁挂|墙灯|墙饰|装饰画|十字架|窗|黑板|白板|公告板|菜单板|挂钟|时钟|海报|挂画|安全标识|警示牌|灭火器/i.test(semantic)
    && !/\bdoor\b|房门|门扇/i.test(semantic);
}

export function isCeilingMountedSemantic(semantic: string): boolean {
  return /ceiling[-_ ]?mounted|ceiling[-_ ]?light|ceiling[-_ ]?lamp|overhead[-_ ]?light|pendant[-_ ]?light|industrial[-_ ]?light|顶装|顶灯|吊灯|天花灯|工业照明/i.test(semantic);
}

export function indoorFallbackTargetHeight(map: EditableMap, sizeClass: 'small' | 'medium' | 'large'): number {
  const { height } = getMapPlayerMetrics(map);
  const ratio = sizeClass === 'small' ? 0.35 : sizeClass === 'medium' ? 0.72 : 1.05;
  return Math.min(height * ratio, Math.max(0.5, (map.room?.size[1] ?? map.box.size[1]) * 0.72));
}
