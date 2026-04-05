const body = `"s", 1, "d", "<n2 es='1' sl='7200' sg='0' rc='0' tmp='0' r='3257' v='2.3136531365313653' a='6800' n='7600' o='7800' s='1.208' b='0' p='0.15' c='11' e='0' d='T' f='3.587' g='2.022' h='1.384' i='1' j='0.861' k='0' l='4.058' q='300' m='72.25' t='100' u='28' w='0.4711' x='65.43' y='518.21' z='94.22' aa='4' ab='16' ac='9' ad='0' ae='100' af='100' ag='100' ah='100' ai='100' aj='0' ak='0' al='0' am='0' an='0' ao='100' ap='0' aq='0' ar='1' as='0' at='100' au='100' av='0' aw='100' ax='0'/>", "t", [266,266,266,266,266,266,266,266,266,365,376,388,399,410,421,432,443,455,466,477,488,499,510,522,533,544,555,566,577,589,598,600,603,605,608,610,612,615,617,619,622,624,627,629,631,634,636,638,641,643,646,648,650,653,655,657,660,662,662,655,647,639,632,624,616,608,601,593,585,578,570,562,554,547,539,531,523,515,506,498,490,481,473,465,457,448,440,432,423,415,407,398,390,382,374,365,357,349,340,332]`;

// Check for non-ASCII characters
for (let i = 0; i < body.length; i++) {
  const code = body.charCodeAt(i);
  if (code > 127) {
    console.log(`Non-ASCII character at position ${i}: '${body[i]}' (code: ${code})`);
  }
}

console.log('All characters are ASCII-safe');
console.log('Body length:', body.length);
console.log('Buffer length (latin1):', Buffer.byteLength(body, 'latin1'));
console.log('Buffer length (utf8):', Buffer.byteLength(body, 'utf8'));
