export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";

export interface Talent {
  id: string;
  name: string;
  role: string;
}

export interface Location {
  id: string;
  name: string;
}

export interface Equipment {
  id: string;
  name: string;
}

export interface Scene {
  id: string;
  code: string;
  title: string;
  day: string;
  start: string;
  end: string;
  talentIds: string[];
  locationId: string;
  equipmentIds: string[];
  status: SceneStatus;
  locked: boolean;
}

export interface TalentBlock {
  id: string;
  talentId: string;
  day: string;
  start: string;
  end: string;
  reason?: string;
}

export type PlanStatus = "待确认" | "已确认待提交" | "写入失败";

export interface RescheduleItem {
  sceneId: string;
  kind: "锚点" | "顺延";
  fromDay: string;
  fromStart: string;
  fromEnd: string;
  toDay: string;
  toStart: string;
  toEnd: string;
}

export interface ReschedulePlan {
  id: string;
  anchorSceneId: string;
  anchorCode: string;
  requestedDay: string;
  requestedStart: string;
  status: PlanStatus;
  createdAt: string;
  basisRevision: number;
  feasible: boolean;
  items: RescheduleItem[];
  earliestDay?: string;
  earliestStart?: string;
  reasonSceneId?: string;
  reasonMessage?: string;
  error?: string;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
}

export interface HistoryEntry {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export interface Version {
  id: string;
  name: string;
  time: string;
  scenes: Scene[];
}

export interface OfflineDraft {
  scenes: Scene[];
  savedAt: string;
}
