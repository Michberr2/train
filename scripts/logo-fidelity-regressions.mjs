import assert from 'node:assert/strict'
import {logoRequestText,enforceLogoName} from '../api/_logoFidelity.ts'
const original='create me a logo for unicorns'
const answers='it is for younger folks and it is for a fantasy book\na unicorn and whimsical'
const polluted=`ORIGINAL REQUEST: ${original}\n\nQuestions asked: Is it for Trevor Park, a tech company, or a fantasy book?\n\nThe user has now answered below — use BOTH the original request and these answers:\n\n${answers}`
const clean=logoRequestText({},polluted)
assert.ok(clean.includes(original));assert.ok(clean.includes(answers));assert.ok(!clean.includes('Trevor Park'))
const supplied=logoRequestText({logoBrief:{request:original,answers}},polluted)
assert.ok(supplied.includes(original));assert.ok(supplied.includes('whimsical'));assert.ok(!supplied.includes('Trevor Park'))
const wrong={kind:'logo',name:'Trevor Park',initials:'TP',symbol:'a whimsical unicorn',literal:true,mark:'bad',options:[{lockup:'bad'}]}
const safe=enforceLogoName(wrong,supplied)
assert.equal(safe.name,'');assert.equal(safe.initials,'');assert.equal(safe.symbol,'a whimsical unicorn');assert.equal(safe.mark,undefined);assert.equal(safe.options,undefined)
assert.equal(wrong.name,'Trevor Park','validation must not mutate the saved source')
assert.equal(enforceLogoName({name:'Luna & Moss',initials:'LM'},'A whimsical unicorn logo for a fantasy book called Luna & Moss.').name,'Luna & Moss')
assert.equal(enforceLogoName({name:'Park',initials:'P'},'A sparkly unicorn.').name,'','substring collisions cannot establish a name')
assert.equal(enforceLogoName({name:'James Brown',initials:'JB'},'Make a monogram with the letters JB.').initials,'JB')
assert.equal(enforceLogoName({name:'',initials:'U'},original).initials,'','a subject does not authorize a monogram')
assert.equal(enforceLogoName({name:'',initials:''},'Create a whimsical unicorn logo for a fantasy book titled Luna & Moss for younger readers.').name,'Luna & Moss','an explicit book title must not be dropped')
assert.equal(enforceLogoName({name:'Wrong',initials:'W'},'Create a logo for a book called "Magic in the Moonlight".').name,'Magic in the Moonlight')
console.log('PASS: original brief and answers preserved, assistant examples excluded, invented name/initials/wordmarks removed, explicit names preserved.')
