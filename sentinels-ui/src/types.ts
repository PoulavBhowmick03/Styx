export type Pause={time:number;reason:string;tx:string;outcome:'open'|'catch'|'false_alarm'};
export type Member={id:string;kind:string;generation:number;params:Record<string,number>;public_key:string;status:'active'|'retired';notes:string[];pauses:Pause[];score:number;catches:number;false_alarms:number};
export type ChainEvent={type:string;time:number;tx:string;recipient?:string;amount?:number;sentinel?:string|null;reason?:string|null};
export type LineageEntry={time:number;action:string;member?:string;parent?:string|null;reason?:string;score?:number;false_alarms?:number;outcome?:string;why?:string;label?:string;notes?:string[];error?:string;evidence?:Record<string,unknown>};
export type OwnerAction={action:'enable'|'remove';member:string;public_key:string;link:string;done?:boolean;cancelled?:boolean};
export type State={vault?:string;network?:string;paused?:boolean;rehearsal?:boolean;dry_run?:boolean;caption?:string;members?:Member[];events?:ChainEvent[];lineage?:LineageEntry[];owner_actions?:OwnerAction[];sign_all?:string|null;attack_windows?:[number,number,string][]};
