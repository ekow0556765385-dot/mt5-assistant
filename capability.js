/* ══════════════════════════════════════════════════════════════════
   WHAT THE GOVERNOR KNOWS ABOUT ITS ENGINES

   The governor already carries a real job description for the two
   original engines — `label`, `built` (what it is for, in words),
   `admits`, `retains`, `outOfScope` (why it is being refused, in words).
   That is genuinely how it should work: it does not delegate by name, it
   delegates because conditions match what an engine was built for.

   But it knows NOTHING about chop or drift. They were bolted on outside
   it — consulted only for the market it failed to hand over. That makes
   them second-class: the governor cannot revoke them, cannot brief them,
   and cannot explain why they are running.

   This gives all four the same standing, in the same shape the governor
   already uses, so it can reason about every engine the same way.
   ══════════════════════════════════════════════════════════════════ */
(function(root){
'use strict';

const SCOPES = {
  chop: {
    label: 'Chop engine',
    built: 'mapping a market that is being contained — where the edges are, '+
           'whether excursions are given back, and where the traps are',
    /* Needs containment PROVEN, not assumed: edges that have been tested
       and excursions that came back. A random walk fails this at 2%. */
    admits(v){ return !v.trending && v.chopSweeps>=2 && v.chopReject>=0.60 && v.chopVisits<0.45; },
    retains(v){ return !v.trending && v.chopSweeps>=2 && v.chopReject>=0.50; },
    outOfScope(v){
      if(v.trending) return 'the market is trending — containment is not the question here';
      if(v.chopSweeps<2) return 'the edges have not been tested enough times to judge containment';
      if(v.chopReject<0.5) return 'excursions beyond the edges are not being given back — nothing is containing price';
      return 'price is sitting in the middle rather than working the edges';
    }
  },
  drift: {
    label: 'Drift engine',
    built: 'reading a market where nothing is being defended — which levels '+
           'price has walked straight through, and what would have to change',
    /* The lowest-priority claim by design: it is what is true when no
       other engine can say anything, and it must not be able to take a
       market that is actually trending. */
    admits(v){ return !v.trending && v.driftTested>=3 && v.driftPass>=0.55 && v.directionless; },
    retains(v){ return !v.trending && v.driftPass>=0.45; },
    outOfScope(v){
      if(v.trending) return 'the market is trending — levels being left behind is what a trend does';
      if(!v.directionless) return 'levels are being left behind, but price is going somewhere';
      if(v.driftTested<3) return 'not enough levels have been tested to judge';
      return 'price is respecting its levels — another engine owns this';
    }
  }
};

/* The order a tie is broken in. Not arbitrary: a stronger claim about
   the market beats a weaker one, and drift is deliberately last because
   "nothing is holding" is only true once nothing else can be said. */
const PRIORITY = ['pullback','range','chop','drift'];

/* Turn the four engines' readings into the flat vocabulary the
   governor's scope tests expect, so it reasons about all of them the
   same way rather than special-casing the new two. */
function vocabulary(structure, chopRead, driftRead){
  const v = {
    trending: !!(structure && (structure.regime==='uptrend'||structure.regime==='downtrend') && structure.confidence>=0.6),
    confidence: (structure&&structure.confidence)||0,
    chopSweeps: (chopRead&&chopRead.sweeps)||0,
    chopReject: (chopRead&&chopRead.rejectRate)||0,
    chopVisits: (chopRead&&chopRead.visits!=null)?chopRead.visits:1,
    driftTested: (driftRead&&driftRead.levelsTested)||0,
    driftPass: (driftRead&&driftRead.passRate)||0,
    directionless: !!(driftRead && Math.abs(driftRead.efficiency||0)<0.12)
  };
  return v;
}

root.BWCapability={SCOPES, PRIORITY, vocabulary};
})(typeof window!=='undefined'?window:globalThis);
