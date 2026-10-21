// patternDetector.js — v2 (Blackwood candle rulebook v2)
// FALLBACK detector for the Pattern Alerts tab. The EA (v5.0+) now sends the
// closed-candle patterns itself as `closedPatterns`, worked out by the SAME
// rulebook block the CandlePattern indicator draws, with confidence and
// follow-through; app.js alerts from those. This file runs only when a feed
// has no closedPatterns (an older EA). The rulebook below is GENERATED from
// the MQL5 block (bwc_block.mqh) — do not edit it by hand; change the MQL5
// block and regenerate, so the chart and the server can never drift apart.
// Each candle: { o, h, l, c, t } (t = timestamp). The last candle is forming.
'use strict';










var BWC_MAX=64;
let bwc_o=[], bwc_h=[], bwc_l=[], bwc_c=[];
var bwc_n = 0;
var bwc_cnt = 0;
let bwc_name=[];   
let bwc_short=[];  
let bwc_dir=[];    
let bwc_kind=[];   
let bwc_span=[];   
let bwc_conf=[];   
let bwc_id=[];     
let bwc_note=[];   
let bwc_set=[];    
var BWC_A = 0, BWC_AB = 0, BWC_TOL = 0;
function BWC_Bd(s){ return Math.abs(bwc_c[s]-bwc_o[s]); }
function BWC_Rg(s){ return bwc_h[s]-bwc_l[s]; }
function BWC_Top(s){ return Math.max(bwc_o[s],bwc_c[s]); }
function BWC_Bot(s){ return Math.min(bwc_o[s],bwc_c[s]); }
function BWC_Uw(s){ return bwc_h[s]-BWC_Top(s); }
function BWC_Lw(s){ return BWC_Bot(s)-bwc_l[s]; }
function BWC_Mid(s){ return (bwc_o[s]+bwc_c[s])/2.0; }
function BWC_Up(s){ return bwc_c[s]>bwc_o[s]; }
function BWC_Dn(s){ return bwc_c[s]<bwc_o[s]; }
function BWC_Long(s){ return BWC_Bd(s)>=Math.max(BWC_AB*1.1,BWC_Rg(s)*0.55) && BWC_Rg(s)>=BWC_A*0.8; }
function BWC_Short(s){ return BWC_Bd(s)<=BWC_AB*0.6; }
function BWC_Doji(s){ return BWC_Rg(s)>0 && BWC_Bd(s)<=BWC_Rg(s)*0.1; }
function BWC_Maru(s){ return BWC_Bd(s)>=BWC_Rg(s)*0.9 && BWC_Rg(s)>=BWC_A*0.9; }
function BWC_Near(u,v){ return Math.abs(u-v)<=BWC_TOL; }
function BWC_GapUp(x,q){ return BWC_Bot(q)>BWC_Top(x); }   
function BWC_GapDn(x,q){ return BWC_Top(q)<BWC_Bot(x); }
function BWC_Inside(x,p){ return bwc_h[x]<bwc_h[p] && bwc_l[x]>bwc_l[p]; }
function BWC_Clamp(v){ return v<0?0:(v>1?1:v); }


function BWC_Trend(s)
  {
   if(s+7 >= bwc_n) return 0;
   let d = bwc_c[s+1]-bwc_c[s+7];
   if(d >  BWC_A*0.8) return  1;
   if(d < -BWC_A*0.8) return -1;
   return 0;
  }


function BWC_Add(id,name,shrt,dir,kind,span,i,shape,note,set,want)
  {
   if((set & want)==0) return;
   if(bwc_cnt>=BWC_MAX) return;
   let lo=bwc_l[i], hi=bwc_h[i];
   for(let k=i;k<i+span;k++){ lo=Math.min(lo,bwc_l[k]); hi=Math.max(hi,bwc_h[k]); }
   let size = BWC_Clamp(((hi-lo)/(BWC_A*span*0.8) - 0.4)/1.2);   
   let cf = Math.round(55 + 44*(0.55*BWC_Clamp(shape) + 0.45*size));
   bwc_id[bwc_cnt]=id; bwc_name[bwc_cnt]=name; bwc_short[bwc_cnt]=shrt; bwc_dir[bwc_cnt]=dir;
   bwc_kind[bwc_cnt]=kind; bwc_span[bwc_cnt]=span; bwc_conf[bwc_cnt]=cf; bwc_note[bwc_cnt]=note; bwc_set[bwc_cnt]=set;
   bwc_cnt++;
  }


function BWC_Context(i)
  {
   let s=0; let n=0;
   for(let k=i;k<bwc_n && k<i+50;k++){ let r=bwc_h[k]-bwc_l[k]; if(r>0){ s+=r; n++; } }
   if(n==0) return false;
   BWC_A = s/n;
   let sb=0; let nb=0;
   for(let k=i;k<bwc_n && k<i+20;k++){ sb+=Math.abs(bwc_c[k]-bwc_o[k]); nb++; }
   BWC_AB = (nb>0)? sb/nb : 0;
   BWC_TOL = BWC_A*0.06;
   return true;
  }


function BWC_Scan(i,want)
  {
   bwc_cnt=0;
   if(i+12 >= bwc_n) return;
   if(!BWC_Context(i)) return;
   let A=BWC_A, TOL=BWC_TOL;
   let c=i, b=i+1, a=i+2, z=i+3, y=i+4;
   let T1=BWC_Trend(c), T2=BWC_Trend(b), T3=BWC_Trend(a), T5=BWC_Trend(y);
   let cB=BWC_Bd(c), cR=BWC_Rg(c), cU=BWC_Uw(c), cL=BWC_Lw(c);

   
   if(cR>=A*0.35)
     {
      if(BWC_Doji(c))
        {
         if(cU<=cR*0.1 && cL>=cR*0.6)
            BWC_Add(3,"Dragonfly Doji","Dragonfly",T1<0?1:0,T1<0?0:2,1,i,cL/cR,"Sellers pushed price down and buyers took it all back",3,want);
         else if(cL<=cR*0.1 && cU>=cR*0.6)
            BWC_Add(4,"Gravestone Doji","Gravestone",T1>0?-1:0,T1>0?0:2,1,i,cU/cR,"Buyers pushed price up and sellers took it all back",3,want);
         else if(cR>=A*1.1 && cU>=cR*0.3 && cL>=cR*0.3)
            BWC_Add(2,"Long-legged Doji","LL Doji",0,2,1,i,Math.min(cU,cL)/cR*2,"Both sides pushed hard and neither won",3,want);
         else
            BWC_Add(1,"Doji","Doji",0,2,1,i,1-cB/(cR*0.1),"Open and close at the same price: indecision",3,want);
        }
      else if(cL>=cB*2 && cU<=cR*0.15)
        {
         if(T1<0 && cL>=cB*3 && cU<=cR*0.05) BWC_Add(6,"Takuri","Takuri",1,0,1,i,cL/cR,"A very long lower wick after a fall: buyers rejected lower prices",3,want);
         else if(T1<0) BWC_Add(5,"Hammer","Hammer",1,0,1,i,cL/cR,"Long lower wick after a fall: buyers rejected lower prices",3,want);
         else if(T1>0) BWC_Add(7,"Hanging Man","Hanging Man",-1,0,1,i,cL/cR,"Long lower wick after a rise: selling showed up",3,want);
         else if(cL>=cR*0.66 && cR>=A*1.1) BWC_Add(10,"Bullish Pin Bar","Bull Pin",1,0,1,i,cL/cR,"Long tail rejecting lower prices",3,want);
        }
      else if(cU>=cB*2 && cL<=cR*0.15)
        {
         if(T1>0) BWC_Add(9,"Shooting Star","Shooting Star",-1,0,1,i,cU/cR,"Long upper wick after a rise: sellers rejected higher prices",3,want);
         else if(T1<0) BWC_Add(8,"Inverted Hammer","Inv Hammer",1,0,1,i,cU/cR,"Long upper wick after a fall: buyers tested higher",3,want);
         else if(cU>=cR*0.66 && cR>=A*1.1) BWC_Add(11,"Bearish Pin Bar","Bear Pin",-1,0,1,i,cU/cR,"Long tail rejecting higher prices",3,want);
        }
      else if(BWC_Maru(c))
         BWC_Add(BWC_Up(c)?12:13,BWC_Up(c)?"Bullish Marubozu":"Bearish Marubozu",BWC_Up(c)?"Bull Maru":"Bear Maru",BWC_Up(c)?1:-1,1,1,i,(cB/cR-0.9)*10,"All body, no wicks: one side in full control",3,want);
      else if(BWC_Up(c) && cL<=cR*0.05 && cB>=cR*0.6 && cR>=A*0.9 && T1<0)
         BWC_Add(14,"Bullish Belt Hold","Bull Belt",1,0,1,i,cB/cR,"Opened at the low and rallied after a fall",1,want);
      else if(BWC_Dn(c) && cU<=cR*0.05 && cB>=cR*0.6 && cR>=A*0.9 && T1>0)
         BWC_Add(15,"Bearish Belt Hold","Bear Belt",-1,0,1,i,cB/cR,"Opened at the high and sold off after a rise",1,want);
      else if(cB<=cR*0.3 && cU>=cR*0.3 && cL>=cR*0.3 && cR>=A*1.3)
         BWC_Add(16,"High Wave","High Wave",0,2,1,i,Math.min(cU,cL)/cR*2,"Wild swings both ways and a small body",3,want);
      else if(cB<=cR*0.3 && cU>cB && cL>cB && cR>=A*0.5)
         BWC_Add(17,"Spinning Top","Spinning Top",0,2,1,i,1-cB/(cR*0.3),"Small body with wicks both sides: momentum paused",3,want);
     }

   
   let bB=BWC_Bd(b);
   let engBull = BWC_Dn(b)&&BWC_Up(c)&&BWC_Bot(c)<=BWC_Bot(b)&&BWC_Top(c)>=BWC_Top(b)&&cB>bB*1.05;
   let engBear = BWC_Up(b)&&BWC_Dn(c)&&BWC_Bot(c)<=BWC_Bot(b)&&BWC_Top(c)>=BWC_Top(b)&&cB>bB*1.05;
   let engQ = (bB>0)? (cB/bB-1.05)/1.5 : 1;
   if(engBull&&T2<0) BWC_Add(18,"Bullish Engulfing","Bull Engulfing",1,0,2,i,engQ,"A bullish body swallowed the bearish one before it",3,want);
   if(engBear&&T2>0) BWC_Add(19,"Bearish Engulfing","Bear Engulfing",-1,0,2,i,engQ,"A bearish body swallowed the bullish one before it",3,want);
   let inBody = BWC_Top(c)<=BWC_Top(b)&&BWC_Bot(c)>=BWC_Bot(b)&&cB<bB*0.6;
   let harQ = (bB>0)? 1-cB/(bB*0.6) : 0;
   if(BWC_Long(b)&&inBody&&BWC_Dn(b)&&T2<0)
     {
      if(BWC_Doji(c))     BWC_Add(22,"Bullish Harami Cross","Bull Harami X",1,0,2,i,harQ,"A doji inside a big bearish candle: selling stalled",3,want);
      else if(BWC_Dn(c))  BWC_Add(24,"Homing Pigeon","Homing Pigeon",1,0,2,i,harQ,"A small bearish candle inside a big one: selling is fading",3,want);
      else                BWC_Add(20,"Bullish Harami","Bull Harami",1,0,2,i,harQ,"A small candle inside a big bearish one: selling stalled",3,want);
     }
   if(BWC_Long(b)&&inBody&&BWC_Up(b)&&T2>0)
     {
      if(BWC_Doji(c))     BWC_Add(23,"Bearish Harami Cross","Bear Harami X",-1,0,2,i,harQ,"A doji inside a big bullish candle: buying stalled",3,want);
      else                BWC_Add(21,"Bearish Harami","Bear Harami",-1,0,2,i,harQ,"A small candle inside a big bullish one: buying stalled",3,want);
     }
   if(BWC_Long(b)&&BWC_Dn(b)&&BWC_Up(c)&&bwc_o[c]<=bwc_c[b]+TOL&&bwc_c[c]>BWC_Mid(b)&&bwc_c[c]<bwc_o[b]&&T2<0)
      BWC_Add(25,"Piercing Line","Piercing Line",1,0,2,i,(bwc_c[c]-BWC_Mid(b))/(bB*0.5),"Closed back above the middle of the big bearish candle",1,want);
   if(BWC_Long(b)&&BWC_Up(b)&&BWC_Dn(c)&&bwc_o[c]>=bwc_c[b]-TOL&&bwc_c[c]<BWC_Mid(b)&&bwc_c[c]>bwc_o[b]&&T2>0)
      BWC_Add(26,"Dark Cloud Cover","Dark Cloud Cover",-1,0,2,i,(BWC_Mid(b)-bwc_c[c])/(bB*0.5),"Closed back below the middle of the big bullish candle",1,want);
   if(BWC_Long(b)&&BWC_Dn(b)&&BWC_Up(c)&&bwc_o[c]<bwc_c[b]&&bwc_c[c]>bwc_c[b]&&bwc_c[c]<=bwc_c[b]+bB*0.1&&T2<0)
      BWC_Add(27,"In-Neck","In-Neck",-1,1,2,i,0.5,"A weak bounce that only reached the prior close: sellers still in charge",1,want);
   if(BWC_Long(b)&&BWC_Dn(b)&&BWC_Up(c)&&bwc_o[c]<bwc_l[b]&&BWC_Near(bwc_c[c],bwc_l[b])&&T2<0)
      BWC_Add(28,"On-Neck","On-Neck",-1,1,2,i,0.5,"A weak bounce that stopped at the prior low: sellers still in charge",1,want);
   if(BWC_Long(b)&&BWC_Dn(b)&&BWC_Up(c)&&bwc_o[c]<bwc_c[b]&&bwc_c[c]>bwc_c[b]+bB*0.1&&bwc_c[c]<BWC_Mid(b)&&T2<0)
      BWC_Add(29,"Thrusting","Thrusting",-1,1,2,i,0.5,"A bounce that failed below the middle of the drop",1,want);
   if(BWC_Long(b)&&BWC_Long(c)&&BWC_Dn(b)&&BWC_Up(c)&&BWC_Near(bwc_c[c],bwc_c[b])&&T2<0)
      BWC_Add(30,"Bullish Counterattack","Bull Counter",1,0,2,i,0.6,"Buyers fought price all the way back to the prior close",1,want);
   if(BWC_Long(b)&&BWC_Long(c)&&BWC_Up(b)&&BWC_Dn(c)&&BWC_Near(bwc_c[c],bwc_c[b])&&T2>0)
      BWC_Add(31,"Bearish Counterattack","Bear Counter",-1,0,2,i,0.6,"Sellers fought price all the way back to the prior close",1,want);
   if(BWC_Dn(b)&&BWC_Dn(c)&&BWC_Near(bwc_c[c],bwc_c[b])&&BWC_Long(b)&&T2<0)
      BWC_Add(32,"Matching Low","Matching Low",1,0,2,i,0.6,"Two closes at the same low: a floor is forming",1,want);
   if(BWC_Up(b)&&BWC_Up(c)&&BWC_Near(bwc_c[c],bwc_c[b])&&BWC_Long(b)&&T2>0)
      BWC_Add(33,"Matching High","Matching High",-1,0,2,i,0.6,"Two closes at the same high: a ceiling is forming",1,want);
   if(BWC_Near(bwc_h[b],bwc_h[c])&&BWC_Up(b)&&BWC_Dn(c)&&T2>0&&BWC_Rg(b)>=A*0.6)
      BWC_Add(34,"Tweezer Top","Tweezer Top",-1,0,2,i,1-Math.abs(bwc_h[b]-bwc_h[c])/TOL,"Two candles rejected the same high",1,want);
   if(BWC_Near(bwc_l[b],bwc_l[c])&&BWC_Dn(b)&&BWC_Up(c)&&T2<0&&BWC_Rg(b)>=A*0.6)
      BWC_Add(35,"Tweezer Bottom","Tweezer Bottom",1,0,2,i,1-Math.abs(bwc_l[b]-bwc_l[c])/TOL,"Two candles rejected the same low",1,want);
   if(BWC_Dn(b)&&BWC_Up(c)&&BWC_Near(bwc_o[c],bwc_o[b])&&BWC_Long(c)&&T2>0)
      BWC_Add(36,"Bullish Separating Lines","Bull Sep Lines",1,1,2,i,0.6,"The dip was erased at the open: the uptrend carries on",1,want);
   if(BWC_Up(b)&&BWC_Dn(c)&&BWC_Near(bwc_o[c],bwc_o[b])&&BWC_Long(c)&&T2<0)
      BWC_Add(37,"Bearish Separating Lines","Bear Sep Lines",-1,1,2,i,0.6,"The bounce was erased at the open: the downtrend carries on",1,want);
   if(BWC_Dn(b)&&BWC_Up(c)&&bwc_o[c]>=bwc_o[b]&&bB>=BWC_Rg(b)*0.8&&cB>=cR*0.8&&BWC_Long(b)&&BWC_Long(c))
      BWC_Add(38,"Bullish Kicker","Bull Kicker",1,0,2,i,0.8,"Price jumped above the bearish candle and never looked back",1,want);
   if(BWC_Up(b)&&BWC_Dn(c)&&bwc_o[c]<=bwc_o[b]&&bB>=BWC_Rg(b)*0.8&&cB>=cR*0.8&&BWC_Long(b)&&BWC_Long(c))
      BWC_Add(39,"Bearish Kicker","Bear Kicker",-1,0,2,i,0.8,"Price dropped below the bullish candle and never looked back",1,want);
   if(BWC_Inside(c,b)&&BWC_Long(b))
      BWC_Add(40,"Inside Bar","Inside Bar",0,2,2,i,1-cR/BWC_Rg(b),"The whole candle sits inside the one before: a pause",3,want);
   if(bwc_h[c]>bwc_h[b]&&bwc_l[c]<bwc_l[b]&&cB>=cR*0.5&&!(engBull&&T2<0)&&!(engBear&&T2>0))
      BWC_Add(BWC_Up(c)?41:42,BWC_Up(c)?"Bullish Outside Bar":"Bearish Outside Bar",BWC_Up(c)?"Bull Outside":"Bear Outside",BWC_Up(c)?1:-1,0,2,i,cB/cR,"Took out both the high and the low of the candle before",1,want);

   
   let aB=BWC_Bd(a);
   if(BWC_Long(a)&&BWC_Dn(a)&&BWC_Short(b)&&BWC_Top(b)<=bwc_c[a]+aB*0.1&&BWC_Up(c)&&bwc_c[c]>BWC_Mid(a)&&T3<0)
     {
      let q=(bwc_c[c]-BWC_Mid(a))/(aB*0.5);
      if(!BWC_Doji(b)) BWC_Add(43,"Morning Star","Morning Star",1,0,3,i,q,"A big drop, a pause, then a strong bullish close",3,want);
      else if(bwc_h[b]<bwc_l[a]&&bwc_h[b]<bwc_l[c]) BWC_Add(45,"Bullish Abandoned Baby","Bull Aband Baby",1,0,3,i,q,"A doji left stranded below two candles: a sharp turn",2,want);
      else BWC_Add(44,"Morning Doji Star","Morning Doji",1,0,3,i,q,"A big drop, a doji, then a strong bullish close",2,want);
     }
   if(BWC_Long(a)&&BWC_Up(a)&&BWC_Short(b)&&BWC_Bot(b)>=bwc_c[a]-aB*0.1&&BWC_Dn(c)&&bwc_c[c]<BWC_Mid(a)&&T3>0)
     {
      let q=(BWC_Mid(a)-bwc_c[c])/(aB*0.5);
      if(!BWC_Doji(b)) BWC_Add(46,"Evening Star","Evening Star",-1,0,3,i,q,"A big rise, a pause, then a strong bearish close",3,want);
      else if(bwc_l[b]>bwc_h[a]&&bwc_l[b]>bwc_h[c]) BWC_Add(48,"Bearish Abandoned Baby","Bear Aband Baby",-1,0,3,i,q,"A doji left stranded above two candles: a sharp turn",2,want);
      else BWC_Add(47,"Evening Doji Star","Evening Doji",-1,0,3,i,q,"A big rise, a doji, then a strong bearish close",2,want);
     }
   let solB = BWC_Up(b)&&BWC_Bd(b)>=BWC_Rg(b)*0.55&&BWC_Uw(b)<=BWC_Rg(b)*0.25&&bwc_o[b]>=BWC_Bot(a)-TOL&&bwc_o[b]<=BWC_Top(a)+TOL&&bwc_c[b]>bwc_c[a]&&BWC_Rg(b)>=A*0.6;
   let solC = BWC_Up(c)&&cB>=cR*0.55&&cU<=cR*0.25&&bwc_o[c]>=BWC_Bot(b)-TOL&&bwc_o[c]<=BWC_Top(b)+TOL&&bwc_c[c]>bwc_c[b]&&cR>=A*0.6;
   if(BWC_Up(a)&&aB>=BWC_Rg(a)*0.55&&solB&&solC&&T3<=0)
      BWC_Add(49,"Three White Soldiers","3 White Soldiers",1,0,3,i,(bwc_c[c]-bwc_o[a])/(A*3),"Three strong bullish candles, each closing higher",1,want);
   let crwB = BWC_Dn(b)&&BWC_Bd(b)>=BWC_Rg(b)*0.55&&BWC_Lw(b)<=BWC_Rg(b)*0.25&&bwc_o[b]<=BWC_Top(a)+TOL&&bwc_o[b]>=BWC_Bot(a)-TOL&&bwc_c[b]<bwc_c[a]&&BWC_Rg(b)>=A*0.6;
   let crwC = BWC_Dn(c)&&cB>=cR*0.55&&cL<=cR*0.25&&bwc_o[c]<=BWC_Top(b)+TOL&&bwc_o[c]>=BWC_Bot(b)-TOL&&bwc_c[c]<bwc_c[b]&&cR>=A*0.6;
   if(BWC_Dn(a)&&aB>=BWC_Rg(a)*0.55&&crwB&&crwC&&T3>=0)
      BWC_Add(50,"Three Black Crows","3 Black Crows",-1,0,3,i,(bwc_o[a]-bwc_c[c])/(A*3),"Three strong bearish candles, each closing lower",1,want);
   let bInA = BWC_Top(b)<=BWC_Top(a)&&BWC_Bot(b)>=BWC_Bot(a);
   if(BWC_Long(a)&&BWC_Dn(a)&&BWC_Up(b)&&bInA&&BWC_Up(c)&&bwc_c[c]>bwc_o[a]&&T3<0)
      BWC_Add(51,"Three Inside Up","3 Inside Up",1,0,3,i,(bwc_c[c]-bwc_o[a])/A,"Harami, then a close above the big bearish candle",1,want);
   if(BWC_Long(a)&&BWC_Up(a)&&BWC_Dn(b)&&bInA&&BWC_Dn(c)&&bwc_c[c]<bwc_o[a]&&T3>0)
      BWC_Add(52,"Three Inside Down","3 Inside Down",-1,0,3,i,(bwc_o[a]-bwc_c[c])/A,"Harami, then a close below the big bullish candle",1,want);
   let bEngA = BWC_Bot(b)<=BWC_Bot(a)&&BWC_Top(b)>=BWC_Top(a)&&bB>aB;
   if(BWC_Dn(a)&&BWC_Up(b)&&bEngA&&BWC_Up(c)&&bwc_c[c]>bwc_c[b]&&T3<0)
      BWC_Add(53,"Three Outside Up","3 Outside Up",1,0,3,i,(bwc_c[c]-bwc_c[b])/A,"Bullish engulfing, then a higher close",2,want);
   if(BWC_Up(a)&&BWC_Dn(b)&&bEngA&&BWC_Dn(c)&&bwc_c[c]<bwc_c[b]&&T3>0)
      BWC_Add(54,"Three Outside Down","3 Outside Down",-1,0,3,i,(bwc_c[b]-bwc_c[c])/A,"Bearish engulfing, then a lower close",2,want);
   if(BWC_Up(a)&&BWC_Up(b)&&BWC_Up(c)&&bwc_c[b]>bwc_c[a]&&bwc_c[c]>bwc_c[b]&&bB<aB&&cB<bB&&cU>cB*0.5&&BWC_Uw(b)>bB*0.3&&T3>0&&BWC_Long(a))
      BWC_Add(55,"Advance Block","Adv Block",-1,0,3,i,cU/cR,"Each rally candle smaller with longer upper wicks: buying is tiring",2,want);
   if(BWC_Long(a)&&BWC_Long(b)&&BWC_Up(a)&&BWC_Up(b)&&bwc_c[b]>bwc_c[a]&&BWC_Up(c)&&BWC_Short(c)&&bwc_o[c]>=bwc_c[b]-TOL&&T3>0)
      BWC_Add(56,"Stalled Pattern","Stalled",-1,0,3,i,1-cB/(BWC_AB*0.6),"Two strong rally candles, then a small one: the rally stalls",2,want);
   if(BWC_Long(a)&&BWC_Up(a)&&BWC_Dn(b)&&BWC_GapUp(a,b)&&BWC_Dn(c)&&bwc_o[c]<=BWC_Top(b)&&bwc_o[c]>=BWC_Bot(b)&&bwc_c[c]<bwc_c[a]&&bwc_c[c]>bwc_o[a]&&T3>0)
      BWC_Add(57,"Two Crows","Two Crows",-1,0,3,i,0.6,"Two bearish candles above a rally, the second closing into it",2,want);
   if(BWC_Long(a)&&BWC_Up(a)&&BWC_Dn(b)&&BWC_GapUp(a,b)&&BWC_Dn(c)&&bwc_o[c]>=bwc_o[b]&&bwc_c[c]<=bwc_c[b]&&bwc_c[c]>bwc_c[a]&&T3>0)
      BWC_Add(58,"Upside Gap Two Crows","Gap 2 Crows",-1,0,3,i,0.6,"Two bearish candles stranded above the rally",2,want);
   if(BWC_Doji(a)&&BWC_Doji(b)&&BWC_Doji(c)&&BWC_Rg(a)>=A*0.4)
     {
      if(BWC_GapUp(a,b)&&BWC_GapUp(c,b)) BWC_Add(60,"Bearish Tri-Star","Bear Tri-Star",-1,0,3,i,0.6,"Three dojis with the middle one on top",2,want);
      else if(BWC_GapDn(a,b)&&BWC_GapDn(c,b)) BWC_Add(59,"Bullish Tri-Star","Bull Tri-Star",1,0,3,i,0.6,"Three dojis with the middle one at the bottom",2,want);
     }
   if(BWC_Dn(a)&&BWC_Up(b)&&bwc_l[b]>bwc_c[a]&&BWC_Dn(c)&&BWC_Near(bwc_c[c],bwc_c[a])&&BWC_Long(a)&&T3<0)
      BWC_Add(61,"Stick Sandwich","Stick Sandwich",1,0,3,i,0.6,"Two bearish closes at the same price around a bullish candle",2,want);
   if(BWC_Long(a)&&BWC_Dn(a)&&BWC_Dn(b)&&BWC_Top(b)<=BWC_Top(a)&&BWC_Bot(b)>=BWC_Bot(a)-TOL&&bwc_l[b]<bwc_l[a]&&BWC_Up(c)&&BWC_Short(c)&&bwc_c[c]<bwc_c[b]&&T3<0)
      BWC_Add(62,"Unique Three River","3 River",1,0,3,i,0.6,"A new low rejected, then a small bullish candle",2,want);
   if(BWC_Long(a)&&BWC_Dn(a)&&BWC_Lw(a)>=aB*0.5&&BWC_Dn(b)&&bB<aB&&bwc_l[b]>bwc_l[a]&&BWC_Dn(c)&&!BWC_Maru(c)&&cB>=cR*0.8&&bwc_h[c]<=bwc_h[b]&&bwc_l[c]>=bwc_l[b]&&T3<0)
      BWC_Add(63,"Three Stars in the South","3 Stars South",1,0,3,i,0.6,"Each bearish candle smaller, with higher lows: selling dries up",2,want);
   if(BWC_Up(a)&&BWC_Up(b)&&BWC_GapUp(a,b)&&BWC_Dn(c)&&bwc_o[c]<BWC_Top(b)&&bwc_o[c]>BWC_Bot(b)&&bwc_c[c]<BWC_Bot(b)&&bwc_c[c]>BWC_Top(a)&&T3>0)
      BWC_Add(64,"Upside Tasuki Gap","Up Tasuki",1,1,3,i,0.6,"A dip that did not close the gap: the uptrend carries on",2,want);
   if(BWC_Dn(a)&&BWC_Dn(b)&&BWC_GapDn(a,b)&&BWC_Up(c)&&bwc_o[c]<BWC_Top(b)&&bwc_o[c]>BWC_Bot(b)&&bwc_c[c]>BWC_Top(b)&&bwc_c[c]<BWC_Bot(a)&&T3<0)
      BWC_Add(65,"Downside Tasuki Gap","Down Tasuki",-1,1,3,i,0.6,"A bounce that did not close the gap: the downtrend carries on",2,want);
   if(BWC_Up(a)&&BWC_Up(b)&&BWC_Up(c)&&BWC_GapUp(a,b)&&BWC_Near(bwc_o[b],bwc_o[c])&&BWC_Near(bB,cB)&&T3>0)
      BWC_Add(66,"Upside Side-by-Side White Lines","Up Side-by-Side",1,1,3,i,0.6,"Two matching bullish candles above a gap",2,want);
   if(BWC_Dn(a)&&BWC_Up(b)&&BWC_Up(c)&&BWC_GapDn(a,b)&&BWC_Near(bwc_o[b],bwc_o[c])&&BWC_Near(bB,cB)&&T3<0)
      BWC_Add(67,"Downside Side-by-Side White Lines","Down Side-by-Side",-1,1,3,i,0.6,"Two matching bullish candles below a gap: the bounce is weak",2,want);

   
   if(BWC_Up(z)&&BWC_Up(a)&&BWC_Up(b)&&bwc_c[a]>bwc_c[z]&&bwc_c[b]>bwc_c[a]&&BWC_Dn(c)&&bwc_o[c]>=bwc_c[b]-TOL&&bwc_c[c]<bwc_o[z]&&T5>=0&&BWC_Long(c))
      BWC_Add(68,"Bullish Three-Line Strike","Bull 3-Line",1,1,4,i,(bwc_o[z]-bwc_c[c])/A,"Three rises wiped out by one candle",2,want);
   if(BWC_Dn(z)&&BWC_Dn(a)&&BWC_Dn(b)&&bwc_c[a]<bwc_c[z]&&bwc_c[b]<bwc_c[a]&&BWC_Up(c)&&bwc_o[c]<=bwc_c[b]+TOL&&bwc_c[c]>bwc_o[z]&&T5<=0&&BWC_Long(c))
      BWC_Add(69,"Bearish Three-Line Strike","Bear 3-Line",-1,1,4,i,(bwc_c[c]-bwc_o[z])/A,"Three drops wiped out by one candle",2,want);
   if(BWC_Dn(z)&&BWC_Dn(a)&&BWC_Maru(z)&&BWC_Maru(a)&&BWC_Dn(b)&&BWC_GapDn(a,b)&&bwc_h[b]>bwc_c[a]&&BWC_Dn(c)&&bwc_o[c]>bwc_h[b]-TOL&&bwc_c[c]<bwc_l[b]&&BWC_Top(c)>=bwc_h[b]-TOL)
      BWC_Add(70,"Concealing Baby Swallow","Baby Swallow",1,0,4,i,0.6,"Selling climax: the last bearish candle swallows the one before",2,want);
   let in3 = BWC_Top(z)<=bwc_h[y]&&BWC_Bot(z)>=bwc_l[y]&&BWC_Top(a)<=bwc_h[y]&&BWC_Bot(a)>=bwc_l[y]&&BWC_Top(b)<=bwc_h[y]&&BWC_Bot(b)>=bwc_l[y];
   if(BWC_Long(y)&&BWC_Up(y)&&BWC_Short(z)&&BWC_Short(a)&&BWC_Short(b)&&in3&&BWC_Up(c)&&BWC_Long(c)&&bwc_c[c]>bwc_c[y]&&T5>0)
      BWC_Add(71,"Rising Three Methods","Rising 3",1,1,5,i,(bwc_c[c]-bwc_c[y])/A,"A small pullback inside a big candle, then a new high",2,want);
   if(BWC_Long(y)&&BWC_Dn(y)&&BWC_Short(z)&&BWC_Short(a)&&BWC_Short(b)&&in3&&BWC_Dn(c)&&BWC_Long(c)&&bwc_c[c]<bwc_c[y]&&T5<0)
      BWC_Add(72,"Falling Three Methods","Falling 3",-1,1,5,i,(bwc_c[y]-bwc_c[c])/A,"A small bounce inside a big candle, then a new low",2,want);
   if(BWC_Long(y)&&BWC_Up(y)&&BWC_Dn(z)&&BWC_GapUp(y,z)&&BWC_Dn(a)&&BWC_Dn(b)&&bwc_c[a]<bwc_c[z]&&bwc_c[b]<bwc_c[a]&&bwc_l[b]>bwc_c[y]&&BWC_Up(c)&&BWC_Long(c)&&bwc_c[c]>bwc_o[z]&&T5>0)
      BWC_Add(73,"Mat Hold","Mat Hold",1,1,5,i,0.6,"A shallow pullback held above the rally, then a new push",2,want);
   if(BWC_Dn(y)&&BWC_Dn(z)&&BWC_Dn(a)&&bwc_c[z]<bwc_c[y]&&bwc_c[a]<bwc_c[z]&&bwc_o[z]<bwc_o[y]&&bwc_o[a]<bwc_o[z]&&BWC_Dn(b)&&BWC_Uw(b)>bB&&BWC_Up(c)&&bwc_o[c]>BWC_Top(b)&&T5<0)
      BWC_Add(74,"Ladder Bottom","Ladder Bottom",1,0,5,i,0.6,"A staircase down, a hesitation, then a jump higher",2,want);
   if(BWC_Long(y)&&BWC_Dn(y)&&BWC_Dn(z)&&BWC_GapDn(y,z)&&bwc_c[a]<bwc_c[z]&&bwc_c[b]<bwc_c[a]&&BWC_Up(c)&&BWC_Long(c)&&bwc_c[c]>BWC_Top(z)&&bwc_c[c]<BWC_Bot(y)&&T5<0)
      BWC_Add(75,"Bullish Breakaway","Bull Breakaway",1,0,5,i,0.6,"A drift lower erased by one strong bullish candle",2,want);
   if(BWC_Long(y)&&BWC_Up(y)&&BWC_Up(z)&&BWC_GapUp(y,z)&&bwc_c[a]>bwc_c[z]&&bwc_c[b]>bwc_c[a]&&BWC_Dn(c)&&BWC_Long(c)&&bwc_c[c]<BWC_Bot(z)&&bwc_c[c]>BWC_Top(y)&&T5>0)
      BWC_Add(76,"Bearish Breakaway","Bear Breakaway",-1,0,5,i,0.6,"A drift higher erased by one strong bearish candle",2,want);
   if(BWC_Inside(a,z)&&bwc_l[b]<bwc_l[a]&&bwc_h[b]<bwc_h[a]&&bwc_c[c]>bwc_h[a])
      BWC_Add(77,"Bullish Hikkake","Bull Hikkake",1,0,4,i,(bwc_c[c]-bwc_h[a])/A,"A false break below an inside bar, then a close above it",2,want);
   if(BWC_Inside(a,z)&&bwc_h[b]>bwc_h[a]&&bwc_l[b]>bwc_l[a]&&bwc_c[c]<bwc_l[a])
      BWC_Add(78,"Bearish Hikkake","Bear Hikkake",-1,0,4,i,(bwc_l[a]-bwc_c[c])/A,"A false break above an inside bar, then a close below it",2,want);
  }




// ── end of generated rulebook ──

const KIND = ['reversal', 'continuation', 'indecision'];
function detectPatterns(candles, timeframe) {
  const results = [];
  if (!Array.isArray(candles)) return results;
  if (candles.length && candles[0] && candles[0].o === undefined && candles[0].open !== undefined) {
    candles = candles.map(k => ({ o: k.open, h: k.high, l: k.low, c: k.close, t: k.time !== undefined ? k.time : k.t }));
  }
  const n = candles.length;
  if (n < 20) return results;
  // series arrays, 0 = newest (the forming candle)
  bwc_n = n; bwc_o = new Array(n); bwc_h = new Array(n); bwc_l = new Array(n); bwc_c = new Array(n);
  for (let s = 0; s < n; s++) { const b = candles[n - 1 - s]; bwc_o[s] = +b.o; bwc_h[s] = +b.h; bwc_l[s] = +b.l; bwc_c[s] = +b.c; }
  // the last 3 CLOSED candles, newest first; the CandlePattern indicator's set (2)
  for (let i = 1; i <= 3; i++) {
    BWC_Scan(i, 2);
    const here = [];
    for (let q = 0; q < bwc_cnt; q++) {
      if (bwc_conf[q] < 44) continue;            // the EA's PD_MinConf / the indicator's MinConfidence
      here.push({
        name: bwc_name[q], short: bwc_short[q],
        direction: bwc_dir[q] > 0 ? 'bullish' : bwc_dir[q] < 0 ? 'bearish' : 'neutral',
        type: KIND[bwc_kind[q]], confidence: bwc_conf[q], timeframe,
        desc: bwc_note[q], follow_pct: -1, follow_base: null, situation: '',
        barsAgo: i, index: n - 1 - i
      });
    }
    here.sort((a, b) => b.confidence - a.confidence);
    results.push(...here);
  }
  return results;   // newest first, as app.js expects (detected[0] = latest)
}

module.exports = { detectPatterns };
