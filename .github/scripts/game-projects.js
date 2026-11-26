// One GitHub Project per game, plus the label -> Status sync.
// Used by .github/workflows/game-projects.yml (setup / rollback) and project-status.yml (sync).
// Every project created here carries MARK in its short description: rollback only deletes those.

const fs = require('fs');
const path = require('path');

const MARK = 'auto:bendk97-neogeo-bugs';
const GAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'games.json'), 'utf8'));
const STATUS_MAP = { 'to test': 'To test', 'in progress': 'In progress', 'backlog': 'Backlog', 'fixed': 'Done' };
const REST = { 'X-GitHub-Api-Version': '2026-03-10' };
const CREATABLE = new Set(['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT']);

const title = label => `${GAMES[label]} bugs`;

const FIELD_FRAG = `... on ProjectV2FieldCommon { id databaseId name dataType }
  ... on ProjectV2SingleSelectField { options { id name color description } }`;
const NAME = `... on ProjectV2FieldCommon { name }`;
const PROJECT_FRAG = `id number title shortDescription public url
  fields(first: 50) { nodes { ${FIELD_FRAG} } }
  views(first: 50) { nodes { number name layout filter
    groupByFields(first: 5) { nodes { ${NAME} } }
    verticalGroupByFields(first: 5) { nodes { ${NAME} } }
    fields(first: 50) { nodes { ${NAME} } } } }`;

async function getUser(github, login) {
  const r = await github.graphql(`query($l: String!) { user(login: $l) { id databaseId } }`, { l: login });
  return r.user;
}

async function getProject(github, login, number) {
  const r = await github.graphql(`query($l: String!, $n: Int!) { user(login: $l) { projectV2(number: $n) { ${PROJECT_FRAG} } } }`,
    { l: login, n: number });
  return r.user.projectV2;
}

async function listProjects(github, login) {
  const r = await github.graphql(`query($l: String!) { user(login: $l) { projectsV2(first: 100) {
    nodes { id number title shortDescription } } } }`, { l: login });
  return r.user.projectsV2.nodes;
}

// Projects created by this script, keyed by game label.
async function gameProjects(github, login) {
  const all = await listProjects(github, login);
  const out = {};
  for (const label of Object.keys(GAMES)) {
    const p = all.find(x => x.title === title(label) && (x.shortDescription || '').includes(MARK));
    if (p) out[label] = p;
  }
  return out;
}

function statusLabel(issue) {
  const labels = issue.labels.map(l => (typeof l === 'string' ? l : l.name).toLowerCase());
  return Object.keys(STATUS_MAP).find(l => labels.includes(l));
}

function gameLabels(issue) {
  return issue.labels.map(l => (typeof l === 'string' ? l : l.name).toLowerCase()).filter(l => GAMES[l]);
}

// Adds the issue to the project (if needed) and sets its Status from the labels.
async function syncIssue(github, core, projectId, issue, cache = {}) {
  if (!cache[projectId]) {
    const r = await github.graphql(`query($id: ID!) { node(id: $id) { ... on ProjectV2 {
      field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`, { id: projectId });
    cache[projectId] = r.node.field;
  }
  const field = cache[projectId];
  const r = await github.graphql(`query($id: ID!) { node(id: $id) { ... on Issue {
    projectItems(first: 50) { nodes { id project { id } } } } } }`, { id: issue.node_id });
  let item = r.node.projectItems.nodes.find(n => n.project.id === projectId);
  if (!item) {
    const a = await github.graphql(`mutation($p: ID!, $c: ID!) {
      addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`, { p: projectId, c: issue.node_id });
    item = a.addProjectV2ItemById.item;
  }
  const label = statusLabel(issue);
  if (!label) { core.info(`  #${issue.number}: no status label`); return; }
  const opt = field && field.options.find(o => o.name.toLowerCase() === STATUS_MAP[label].toLowerCase());
  if (!opt) { core.warning(`  #${issue.number}: no "${STATUS_MAP[label]}" option in Status`); return; }
  await github.graphql(`mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f,
      value: { singleSelectOptionId: $o } }) { projectV2Item { id } } }`,
    { p: projectId, i: item.id, f: field.id, o: opt.id });
  core.info(`  #${issue.number}: ${label} -> ${opt.name}`);
}

// Removes game labels from "label:" filters (a per-game project only holds that game).
function cleanFilter(filter) {
  if (!filter) return '';
  return filter.split(/\s+/).map(tok => {
    const m = tok.match(/^(-?label:)(.*)$/i);
    if (!m) return tok;
    const kept = m[2].split(',').filter(v => !GAMES[v.replace(/"/g, '').toLowerCase()]);
    return kept.length ? m[1] + kept.join(',') : '';
  }).filter(Boolean).join(' ');
}

const LAYOUT = { BOARD_LAYOUT: 'board', TABLE_LAYOUT: 'table', ROADMAP_LAYOUT: 'roadmap' };

async function setup({ github, context, core, templateNumber, viewNumber, only }) {
  const login = context.repo.owner;
  const user = await getUser(github, login);
  const template = await getProject(github, login, templateNumber);
  const view = template.views.nodes.find(v => v.number === viewNumber);
  if (!view) { core.setFailed(`View ${viewNumber} not found in project ${templateNumber}`); return; }
  core.info(`Template: project ${templateNumber} "${template.title}", view ${view.number} "${view.name}"`);
  core.info(JSON.stringify({
    layout: view.layout, filter: view.filter,
    groupBy: view.groupByFields.nodes.map(f => f.name),
    columns: view.verticalGroupByFields.nodes.map(f => f.name),
    visible: view.fields.nodes.map(f => f.name),
  }, null, 2));

  const repo = (await github.rest.repos.get({ owner: login, repo: context.repo.repo })).data;
  const existing = await gameProjects(github, login);
  const labels = only ? only.split(',').map(s => s.trim()).filter(l => GAMES[l]) : Object.keys(GAMES);
  const report = [];

  for (const label of labels) {
    core.startGroup(title(label));
    let pid, number;
    if (existing[label]) {
      ({ id: pid, number } = existing[label]);
      core.info(`exists: project ${number}`);
    } else {
      const c = await github.graphql(`mutation($o: ID!, $t: String!, $r: ID!) {
        createProjectV2(input: { ownerId: $o, title: $t, repositoryId: $r }) { projectV2 { id number } } }`,
        { o: user.id, t: title(label), r: repo.node_id });
      ({ id: pid, number } = c.createProjectV2.projectV2);
      await github.graphql(`mutation($p: ID!, $d: String!, $pub: Boolean!) {
        updateProjectV2(input: { projectId: $p, shortDescription: $d, public: $pub }) { projectV2 { id } } }`,
        { p: pid, d: `Bugs ${GAMES[label]} (${MARK})`, pub: template.public });
      core.info(`created: project ${number}`);
    }

    // Fields: same Status options as the template, plus its custom fields.
    let proj = await getProject(github, login, number);
    for (const tf of template.fields.nodes) {
      const nf = proj.fields.nodes.find(f => f.name === tf.name);
      const opts = (tf.options || []).map(o => ({ name: o.name, color: o.color, description: o.description || '' }));
      if (nf && tf.dataType === 'SINGLE_SELECT' && nf.dataType === 'SINGLE_SELECT') {
        const same = JSON.stringify(opts.map(o => o.name)) === JSON.stringify((nf.options || []).map(o => o.name));
        if (!same) {
          await github.graphql(`mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
            updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) { projectV2Field { __typename } } }`,
            { f: nf.id, o: opts });
          core.info(`field ${tf.name}: options set`);
        }
      } else if (!nf && CREATABLE.has(tf.dataType)) {
        const vars = { p: pid, n: tf.name, d: tf.dataType };
        if (tf.dataType === 'SINGLE_SELECT') vars.o = opts;
        await github.graphql(`mutation($p: ID!, $n: String!, $d: ProjectV2CustomFieldType!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
          createProjectV2Field(input: { projectId: $p, name: $n, dataType: $d, singleSelectOptions: $o }) { projectV2Field { __typename } } }`, vars);
        core.info(`field ${tf.name}: created`);
      }
    }
    proj = await getProject(github, login, number);
    const ids = names => names.map(n => (proj.fields.nodes.find(f => f.name === n) || {}).databaseId).filter(Boolean);

    // View: copy of the template view, then drop the default empty one.
    if (!proj.views.nodes.some(v => v.name === view.name)) {
      const body = {
        name: view.name, layout: LAYOUT[view.layout] || 'board', filter: cleanFilter(view.filter),
        visible_fields: ids(view.fields.nodes.map(f => f.name)),
      };
      const cols = ids(view.verticalGroupByFields.nodes.map(f => f.name));
      if (cols.length) body.vertical_group_by = cols;
      const url = `POST /users/${user.databaseId}/projectsV2/${number}/views`;
      try {
        await github.request(url, { ...body, headers: REST });
      } catch (e) {
        core.warning(`view with visible fields refused (${e.message}), retrying without`);
        delete body.visible_fields;
        await github.request(url, { ...body, headers: REST });
      }
      core.info(`view "${view.name}" created`);
      for (const v of proj.views.nodes) {
        try {
          await github.request(`DELETE /users/${user.databaseId}/projectsV2/${number}/views/${v.number}`, { headers: REST });
          core.info(`default view "${v.name}" deleted`);
        } catch (e) { core.info(`default view "${v.name}" kept (${e.status || e.message})`); }
      }
    }

    // Issues of this game.
    const issues = (await github.paginate(github.rest.issues.listForRepo,
      { owner: login, repo: context.repo.repo, state: 'all', labels: label, per_page: 100 })).filter(i => !i.pull_request);
    const cache = {};
    for (const issue of issues) await syncIssue(github, core, pid, issue, cache);
    report.push(`| ${GAMES[label]} | ${issues.length} | https://github.com/users/${login}/projects/${number} |`);
    core.endGroup();
  }

  await core.summary.addRaw(`| Game | Issues | Project |\n|---|---|---|\n${report.join('\n')}\n`).write();
}

async function rollback({ github, context, core }) {
  const login = context.repo.owner;
  const projects = await gameProjects(github, login);
  for (const [label, p] of Object.entries(projects)) {
    await github.graphql(`mutation($p: ID!) { deleteProjectV2(input: { projectId: $p }) { projectV2 { id } } }`, { p: p.id });
    core.info(`deleted project ${p.number} "${p.title}"`);
  }
  if (!Object.keys(projects).length) core.info('nothing to delete');
}

// Game chosen in the issue form ("### Game" section) -> game label.
function gameFromForm(body) {
  const m = (body || '').match(/^###\s*Game\s*\n+([^\n]+)/m);
  if (!m) return null;
  const name = m[1].trim().toLowerCase();
  return Object.keys(GAMES).find(l => GAMES[l].toLowerCase() === name) || null;
}

// Adds the game label of a new issue from its form, so it lands in the right game project.
async function labelFromForm(github, context, core, issue) {
  if (gameLabels(issue).length) return;
  const label = gameFromForm(issue.body);
  if (!label) { core.info(`#${issue.number}: no game in the form`); return; }
  await github.rest.issues.addLabels({ owner: context.repo.owner, repo: context.repo.repo,
    issue_number: issue.number, labels: [label] });
  issue.labels.push({ name: label });
  core.info(`#${issue.number}: label ${label} added from the form`);
}

// Label -> Status sync for the main project and the game projects.
async function sync({ github, context, core, mainNumber }) {
  const login = context.repo.owner;
  let issues;
  if (context.eventName === 'workflow_dispatch') {
    issues = (await github.paginate(github.rest.issues.listForRepo,
      { owner: login, repo: context.repo.repo, state: 'all', per_page: 100 })).filter(i => !i.pull_request);
  } else {
    issues = [context.payload.issue];
    if (['opened', 'edited'].includes(context.payload.action)) await labelFromForm(github, context, core, issues[0]);
  }
  const targets = [];
  if (mainNumber) {
    const r = await github.graphql(`query($l: String!, $n: Int!) { user(login: $l) { projectV2(number: $n) { id } } }`,
      { l: login, n: mainNumber });
    targets.push({ id: r.user.projectV2.id, all: true });
  }
  const games = await gameProjects(github, login);
  const cache = {};
  for (const issue of issues) {
    core.info(`#${issue.number}`);
    const mine = gameLabels(issue);
    for (const t of targets) await syncIssue(github, core, t.id, issue, cache);
    for (const l of mine) if (games[l]) await syncIssue(github, core, games[l].id, issue, cache);
  }
}

module.exports = { setup, rollback, sync, cleanFilter, gameFromForm, GAMES, MARK };
