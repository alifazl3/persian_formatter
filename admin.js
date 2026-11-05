/* Admin dashboard: a tool tab (like the date converter) for accounts whose
   email is in the server's ADMIN_EMAILS. The server checks every request;
   this file only draws what /api/admin returns. */
const admin = {
  allowed: false,
  view: "overview",
  days: 30,
  users: { kind: "account", q: "", sort: "newest", page: 1 },
  shares: { status: "all", q: "", sort: "newest", owner: null, ownerLabel: "", page: 1 },
  loadedAt: null,
};

const adminFa = n => Number(n).toLocaleString("fa-IR");
const adminDay = value => new Date(value).toLocaleDateString("fa-IR", { day: "numeric", month: "long", year: "numeric" });
const adminGuestName = id => `مهمان · ${id.slice(0, 4)}…${id.slice(-2)}`;

/** Small DOM builder: h("div", { class: "x", onclick }, child, "text", …). */
function adminH(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

const ADMIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>';
function adminIcon(markup) {
  const span = adminH("span", { class: "admin-icon", "aria-hidden": "true" });
  span.innerHTML = markup;
  return span;
}

// --- access ---

/** Called with each identity check: shows the button, or closes the tab for non-admins. */
function setAdminAccess(allowed) {
  admin.allowed = allowed;
  document.getElementById("adminEntry").hidden = !allowed;
  if (!allowed) { workspaceDropAdminTab(); return; }
  refreshAdminBadge();
}

async function refreshAdminBadge() {
  try {
    const { reports } = await libraryApi("/admin/reports");
    const badge = document.getElementById("adminBadge");
    badge.hidden = !reports.length;
    badge.textContent = adminFa(reports.length);
    document.getElementById("adminTabBtn").title = reports.length ? `داشبورد مدیریت — ${adminFa(reports.length)} گزارش بررسی‌نشده` : "داشبورد مدیریت";
  } catch (_) { /* The badge is a hint; the dashboard shows errors itself. */ }
}

// --- shell ---

function showAdmin() {
  const root = document.getElementById("adminView");
  if (!admin.allowed) {
    root.replaceChildren(adminH("div", { class: "admin-panel admin-empty" }, "دسترسی به داشبورد مدیریت ندارید."));
    return;
  }
  renderAdminShell();
  loadAdminView();
}

function renderAdminShell() {
  const root = document.getElementById("adminView");
  const views = [["overview", "نمای کلی"], ["users", "کاربران"], ["shares", "لینک‌های اشتراک"]];
  const head = adminH("header", { class: "admin-panel admin-head" },
    adminH("div", { class: "admin-head-title" },
      adminIcon(ADMIN_ICON),
      adminH("h2", { id: "adminTitle" }, "داشبورد مدیریت"),
      adminH("span", { class: "admin-muted", id: "adminUpdated" }),
    ),
    admin.view === "overview" && adminSegmented("بازهٔ زمانی", [7, 30, 90].map(days => [days, `${adminFa(days)} روز`]), admin.days, days => { admin.days = days; renderAdminShell(); loadAdminView(); }),
    adminH("button", { type: "button", class: "admin-button", onclick: () => loadAdminView() }, "به‌روزرسانی"),
  );
  const nav = adminH("nav", { class: "admin-nav", "aria-label": "بخش‌های داشبورد" },
    views.map(([id, label]) => adminH("button", {
      type: "button", class: "admin-nav-item", "aria-current": admin.view === id ? "page" : false,
      onclick: () => { admin.view = id; renderAdminShell(); loadAdminView(); },
    }, label)),
  );
  root.replaceChildren(head, nav, adminH("div", { id: "adminBody", class: "admin-body" }, adminH("p", { class: "admin-muted admin-loading" }, "در حال بارگذاری…")));
}

function adminSegmented(label, options, current, pick) {
  return adminH("div", { class: "admin-segmented", role: "group", "aria-label": label },
    options.map(([value, text]) => adminH("button", {
      type: "button", "aria-pressed": String(value === current), onclick: () => pick(value),
    }, text)),
  );
}

async function loadAdminView() {
  const body = document.getElementById("adminBody");
  try {
    if (admin.view === "overview") renderAdminOverview(body, await libraryApi(`/admin/overview?days=${admin.days}`));
    else if (admin.view === "users") renderAdminUsers(body, await libraryApi(`/admin/users?${new URLSearchParams(admin.users)}`));
    else renderAdminShares(body, await libraryApi(`/admin/shares?${adminShareQuery()}`));
    admin.loadedAt = new Date();
    document.getElementById("adminUpdated").textContent = `به‌روز شده ${admin.loadedAt.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    if (error.status === 404) { setAdminAccess(false); return; }
    body.replaceChildren(adminH("div", { class: "admin-panel admin-empty", role: "alert" }, `بارگذاری نشد: ${error.message}`));
  }
}

function adminShareQuery() {
  const { status, q, sort, owner, page } = admin.shares;
  const params = new URLSearchParams({ status, q, sort, page });
  if (owner) params.set("owner", owner);
  return params;
}

// --- overview ---

function renderAdminOverview(body, data) {
  const t = data.totals;
  const range = `در ${adminFa(data.days)} روز اخیر`;
  const kpis = [
    ["کاربران با حساب", t.accounts, `+${adminFa(t.newAccounts)} ${range}`],
    ["مهمان‌های فعال", t.activeGuests, "نشست باز (۹۰ روز)"],
    ["متن‌های ذخیره‌شده", t.documents, `+${adminFa(t.newDocuments)} ${range}`],
    ["پوشه‌های اشتراکی", t.sharedFolders, `${adminFa(t.folderMembers)} عضو`],
    ["لینک‌های اشتراک", t.shares, `+${adminFa(t.newShares)} · ${adminFa(t.liveShares)} زنده`],
    ["بازدید لینک‌ها", t.views, "از ابتدا"],
  ];
  body.replaceChildren(
    adminH("section", { class: "admin-kpis", "aria-label": "آمار کلی" },
      kpis.map(([label, value, note]) => adminH("div", { class: "admin-panel admin-kpi" },
        adminH("span", { class: "admin-kpi-label" }, label),
        adminH("strong", {}, adminFa(value)),
        adminH("span", { class: "admin-muted" }, note),
      )),
    ),
    adminChart(data.daily),
    adminH("div", { class: "admin-row" },
      adminReportsPanel(),
      adminTopShares(data.topShares),
    ),
    adminH("div", { class: "admin-row" },
      adminNewUsers(data.newUsers),
      adminH("section", { class: "admin-panel admin-admins", "aria-labelledby": "adminAdminsTitle" },
        adminH("h3", { id: "adminAdminsTitle" }, "دسترسی مدیریت"),
        adminH("p", { class: "admin-muted" }, "فقط این ایمیل‌ها دکمهٔ «داشبورد مدیریت» را می‌بینند. فهرست در تنظیمات سرور (ADMIN_EMAILS) است."),
        adminH("ul", { class: "admin-list" }, data.admins.map(email => adminH("li", { dir: "ltr" }, email))),
      ),
    ),
  );
}

function adminChart(days) {
  const max = Math.max(1, ...days.map(d => Math.max(d.documents, d.shares, d.accounts)));
  const pct = n => `${Math.round(n / max * 100)}%`;
  const bars = days.map(d => {
    const label = `${adminDay(`${d.day}T12:00:00`)}: ${adminFa(d.documents)} متن، ${adminFa(d.shares)} لینک، ${adminFa(d.accounts)} حساب تازه`;
    return adminH("div", { class: "admin-bar", title: label },
      adminH("span", { class: "admin-bar-docs", style: `height: ${pct(d.documents)}` }),
      adminH("span", { class: "admin-bar-shares", style: `height: ${pct(d.shares)}` }),
      d.accounts ? adminH("span", { class: "admin-bar-accounts", style: `bottom: ${pct(d.accounts)}` }) : null,
    );
  });
  const totals = days.reduce((sum, d) => ({ documents: sum.documents + d.documents, shares: sum.shares + d.shares, accounts: sum.accounts + d.accounts }), { documents: 0, shares: 0, accounts: 0 });
  const first = days[0], last = days[days.length - 1];
  return adminH("section", { class: "admin-panel", "aria-labelledby": "adminChartTitle" },
    adminH("div", { class: "admin-section-head" },
      adminH("h3", { id: "adminChartTitle" }, "فعالیت روزانه"),
      adminH("span", { class: "admin-legend" }, adminH("i", { class: "admin-swatch admin-bar-docs" }), `متن ذخیره‌شده (${adminFa(totals.documents)})`),
      adminH("span", { class: "admin-legend" }, adminH("i", { class: "admin-swatch admin-bar-shares" }), `لینک ساخته‌شده (${adminFa(totals.shares)})`),
      adminH("span", { class: "admin-legend" }, adminH("i", { class: "admin-swatch admin-line" }), `حساب تازه (${adminFa(totals.accounts)})`),
    ),
    adminH("div", {},
      adminH("div", { class: "admin-chart", role: "img", "aria-label": `در این بازه ${adminFa(totals.documents)} متن ذخیره شد، ${adminFa(totals.shares)} لینک ساخته شد و ${adminFa(totals.accounts)} حساب تازه باز شد. بیشترین مقدار روزانه ${adminFa(max)} است.` }, bars),
      adminH("div", { class: "admin-chart-axis admin-muted" },
        adminH("span", {}, first ? adminDay(`${first.day}T12:00:00`) : ""),
        adminH("span", {}, `بیشینه: ${adminFa(max)} در روز`),
        adminH("span", {}, last ? "امروز" : ""),
      ),
    ),
  );
}

function adminReportsPanel() {
  const list = adminH("div", { class: "admin-reports" }, adminH("p", { class: "admin-muted" }, "در حال بارگذاری…"));
  const count = adminH("span", { class: "admin-pill", hidden: true });
  const panel = adminH("section", { class: "admin-panel admin-grow", "aria-labelledby": "adminReportsTitle" },
    adminH("div", { class: "admin-section-head" }, adminH("h3", { id: "adminReportsTitle" }, "گزارش‌های مشکل"), count),
    list,
  );
  libraryApi("/admin/reports").then(({ reports }) => {
    count.hidden = !reports.length;
    count.textContent = `${adminFa(reports.length)} باز`;
    list.replaceChildren();
    if (!reports.length) list.append(adminH("p", { class: "admin-muted" }, "گزارش بررسی‌نشده‌ای نیست. بیننده‌های صفحه‌های اشتراکی از دکمهٔ «گزارش مشکل» گزارش می‌فرستند."));
    for (const report of reports) {
      list.append(adminH("article", { class: "admin-report" },
        adminH("div", { class: "admin-report-head" },
          adminH("a", { href: `/s/${report.shareId}`, target: "_blank", rel: "noopener" }, report.title),
          adminH("span", { class: "admin-muted" }, libraryDate(report.createdAt)),
        ),
        adminH("p", {}, report.note || "بدون توضیح"),
        adminH("div", { class: "admin-actions" },
          adminH("button", { type: "button", class: "admin-button", onclick: () => resolveAdminReport(report) }, "بررسی شد"),
          adminH("a", { class: "admin-button", href: `/s/${report.shareId}`, target: "_blank", rel: "noopener" }, "باز کردن لینک"),
          adminH("button", { type: "button", class: "admin-button danger", onclick: () => deleteAdminShare({ id: report.shareId, title: report.title }) }, "حذف لینک"),
        ),
      ));
    }
  }).catch(error => list.replaceChildren(adminH("p", { class: "admin-muted", role: "alert" }, error.message)));
  return panel;
}

function adminTopShares(shares) {
  return adminH("section", { class: "admin-panel admin-grow", "aria-labelledby": "adminTopTitle" },
    adminH("div", { class: "admin-section-head" },
      adminH("h3", { id: "adminTopTitle" }, "پربازدیدترین لینک‌ها"),
      adminH("button", { type: "button", class: "admin-link", onclick: () => adminGoShares({ sort: "views" }) }, "دیدن همه"),
    ),
    shares.length ? adminTable("پربازدیدترین لینک‌ها", ["عنوان", "سازنده", "بازدید", ""], shares.map(share => [
      adminShareTitle(share),
      adminOwner(share),
      adminH("strong", { class: "admin-num" }, adminFa(share.viewCount)),
      adminH("button", { type: "button", class: "admin-button danger", "aria-label": `حذف لینک ${share.title}`, onclick: () => deleteAdminShare(share) }, "حذف"),
    ])) : adminH("p", { class: "admin-muted" }, "هنوز لینکی ساخته نشده است."),
  );
}

function adminNewUsers(users) {
  return adminH("section", { class: "admin-panel admin-wide", "aria-labelledby": "adminNewUsersTitle" },
    adminH("div", { class: "admin-section-head" },
      adminH("h3", { id: "adminNewUsersTitle" }, "کاربران تازه"),
      adminH("button", { type: "button", class: "admin-link", onclick: () => { admin.view = "users"; admin.users = { ...admin.users, kind: "account", sort: "newest", page: 1 }; renderAdminShell(); loadAdminView(); } }, "دیدن همه"),
    ),
    users.length ? adminTable("کاربران تازه", ["ایمیل", "عضویت", "متن‌ها", "پوشه‌ها", "لینک‌ها"], users.map(user => [
      adminH("span", { dir: "ltr", class: "admin-email" }, user.email),
      adminH("span", { class: "admin-muted" }, adminDay(user.joinedAt)),
      adminFa(user.documents), adminFa(user.folders), adminFa(user.shares),
    ])) : adminH("p", { class: "admin-muted" }, "هنوز کسی حساب نساخته است."),
  );
}

// --- users ---

function renderAdminUsers(body, data) {
  const state = admin.users;
  const kinds = [["account", "با حساب"], ["guest", "مهمان"], ["all", "همه"]];
  body.replaceChildren(adminH("section", { class: "admin-panel", "aria-labelledby": "adminUsersTitle" },
    adminH("div", { class: "admin-filters" },
      adminH("h3", { id: "adminUsersTitle" }, "کاربران"),
      adminSearch("جستجوی ایمیل", state.q, q => { state.q = q; state.page = 1; loadAdminView(); }),
      adminSegmented("نوع کاربر", kinds.map(([id, label]) => [id, `${label} ${adminFa(data.counts[id])}`]), state.kind, kind => { state.kind = kind; state.page = 1; loadAdminView(); }),
      adminSort([["newest", "جدیدترین"], ["documents", "بیشترین متن"], ["shares", "بیشترین لینک"], ["views", "بیشترین بازدید"]], state.sort, sort => { state.sort = sort; state.page = 1; loadAdminView(); }),
    ),
    state.kind !== "account" && adminH("p", { class: "admin-muted admin-note" }, "مهمان‌ها فقط وقتی دیده می‌شوند که چیزی نگه داشته باشند (متن، پوشه، لینک یا عضویت)."),
    data.users.length ? adminTable("فهرست کاربران", ["کاربر", "نوع", "عضویت", "متن‌ها", "پوشه‌ها", "عضو پوشهٔ دیگران", "لینک‌ها", "بازدید لینک‌ها", ""], data.users.map(user => [
      adminH("span", { dir: user.email ? "ltr" : "auto", class: "admin-email" }, user.email || adminGuestName(user.id)),
      adminH("span", { class: `admin-tag${user.email ? " accent" : ""}` }, user.email ? "حساب" : "مهمان"),
      adminH("span", { class: "admin-muted" }, adminDay(user.joinedAt)),
      adminFa(user.documents), adminFa(user.folders), adminFa(user.memberships), adminFa(user.shares),
      adminH("strong", { class: "admin-num" }, adminFa(user.views)),
      user.shares ? adminH("button", { type: "button", class: "admin-button", onclick: () => adminGoShares({ owner: user.id, ownerLabel: user.email || adminGuestName(user.id) }) }, "لینک‌های او") : "",
    ])) : adminH("p", { class: "admin-muted admin-empty-row" }, "کاربری پیدا نشد."),
    adminPager(data, "کاربر", page => { state.page = page; loadAdminView(); }),
  ));
}

// --- shares ---

function adminGoShares(changes) {
  admin.view = "shares";
  admin.shares = { status: "all", q: "", sort: "newest", owner: null, ownerLabel: "", page: 1, ...changes };
  renderAdminShell();
  loadAdminView();
}

function renderAdminShares(body, data) {
  const state = admin.shares;
  const statuses = [["all", "همه"], ["live", "زنده"], ["expiring", "با انقضا"], ["expired", "منقضی‌شده"], ["reported", "با گزارش"]];
  const now = new Date();
  body.replaceChildren(adminH("section", { class: "admin-panel", "aria-labelledby": "adminSharesTitle" },
    adminH("div", { class: "admin-filters" },
      adminH("h3", { id: "adminSharesTitle" }, "لینک‌های اشتراک"),
      adminSearch("جستجو در متن یا ایمیل سازنده", state.q, q => { state.q = q; state.page = 1; loadAdminView(); }),
      adminSort([["newest", "جدیدترین"], ["views", "پربازدیدترین"], ["reports", "بیشترین گزارش"]], state.sort, sort => { state.sort = sort; state.page = 1; loadAdminView(); }),
    ),
    adminH("div", { class: "admin-filters" },
      adminSegmented("وضعیت لینک", statuses.map(([id, label]) => [id, `${label} ${adminFa(data.counts[id])}`]), state.status, status => { state.status = status; state.page = 1; loadAdminView(); }),
      state.owner && adminH("span", { class: "admin-chip" }, `فقط لینک‌های ${state.ownerLabel}`,
        adminH("button", { type: "button", "aria-label": "برداشتن فیلتر سازنده", onclick: () => { state.owner = null; state.ownerLabel = ""; state.page = 1; loadAdminView(); } }, "×")),
    ),
    data.shares.length ? adminTable("فهرست لینک‌های اشتراک", ["عنوان", "سازنده", "نوع", "بازدید", "ساخت", "انقضا", "گزارش", ""], data.shares.map(share => {
      const expired = share.expiresAt && new Date(share.expiresAt) <= now;
      return [
        adminShareTitle(share, true),
        adminOwner(share),
        adminH("span", { class: `admin-tag${share.live ? " accent" : ""}` }, share.live ? "زنده" : "ثابت"),
        adminH("strong", { class: "admin-num" }, adminFa(share.viewCount)),
        adminH("span", { class: "admin-muted" }, adminDay(share.createdAt)),
        expired ? adminH("span", { class: "admin-danger-text" }, "منقضی‌شده") : adminH("span", { class: "admin-muted" }, share.expiresAt ? `تا ${adminDay(share.expiresAt)}` : "بدون انقضا"),
        share.openReports ? adminH("span", { class: "admin-pill" }, adminFa(share.openReports)) : adminH("span", { class: "admin-muted" }, "—"),
        adminH("div", { class: "admin-actions" },
          adminH("a", { class: "admin-button", href: `/s/${share.id}`, target: "_blank", rel: "noopener" }, "باز کردن"),
          adminH("button", { type: "button", class: "admin-button danger", "aria-label": `حذف لینک ${share.title}`, onclick: () => deleteAdminShare(share) }, "حذف"),
        ),
      ];
    })) : adminH("p", { class: "admin-muted admin-empty-row" }, "لینکی پیدا نشد."),
    adminPager(data, "لینک", page => { state.page = page; loadAdminView(); }),
  ));
}

function adminShareTitle(share, withPath = false) {
  return adminH("div", { class: "admin-share-title" },
    adminH("a", { href: `/s/${share.id}`, target: "_blank", rel: "noopener", title: share.title }, share.title),
    withPath && adminH("span", { class: "admin-muted", dir: "ltr" }, `/s/${share.id}`),
  );
}

function adminOwner(share) {
  if (share.ownerEmail) return adminH("span", { dir: "ltr", class: "admin-email" }, share.ownerEmail);
  return adminH("span", { class: "admin-muted" }, share.ownerId ? adminGuestName(share.ownerId) : "نامشخص");
}

// --- shared controls ---

function adminTable(label, headers, rows) {
  // Focusable so the table can be scrolled sideways from the keyboard on small screens.
  return adminH("div", { class: "admin-scroll", tabindex: "0", role: "region", "aria-label": label },
    adminH("table", { class: "admin-table" },
      adminH("thead", {}, adminH("tr", {}, headers.map(text => adminH("th", { scope: "col" }, text || adminH("span", { class: "visually-hidden" }, "کارها"))))),
      adminH("tbody", {}, rows.map(cells => adminH("tr", {}, cells.map(cell => adminH("td", {}, cell))))),
    ),
  );
}

function adminSearch(label, value, change) {
  let timer;
  const field = adminH("input", { type: "search", placeholder: label, "aria-label": label, value });
  field.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => change(field.value.trim()), 350); });
  return adminH("label", { class: "admin-search" }, adminIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'), field);
}

function adminSort(options, current, change) {
  const select = adminH("select", { "aria-label": "مرتب‌سازی" }, options.map(([value, label]) => {
    const option = new Option(label, value);
    option.selected = value === current;
    return option;
  }));
  select.addEventListener("change", () => change(select.value));
  return adminH("label", { class: "admin-sort" }, "مرتب‌سازی", select);
}

function adminPager(data, noun, go) {
  const items = data.users || data.shares;
  if (!data.total) return null;
  const from = (data.page - 1) * data.pageSize + 1;
  const to = from + items.length - 1;
  const last = Math.max(1, Math.ceil(data.total / data.pageSize));
  return adminH("div", { class: "admin-pager" },
    adminH("span", { class: "admin-muted" }, `نمایش ${adminFa(from)} تا ${adminFa(to)} از ${adminFa(data.total)} ${noun}`),
    adminH("button", { type: "button", class: "admin-button", disabled: data.page <= 1, onclick: () => go(data.page - 1) }, "قبلی"),
    adminH("button", { type: "button", class: "admin-button", disabled: data.page >= last, onclick: () => go(data.page + 1) }, "بعدی"),
  );
}

// --- actions ---

async function resolveAdminReport(report) {
  try {
    await libraryApi(`/admin/reports/${report.id}/resolve`, "POST");
    libraryToast("گزارش بررسی‌شده علامت خورد.");
    refreshAdminBadge();
    loadAdminView();
  } catch (error) { libraryToast(error.message, true); }
}

async function deleteAdminShare(share) {
  if (!await libraryAsk({ title: "حذف لینک", description: `لینک «${share.title}» برای همه حذف شود؟ کسی که لینک را دارد دیگر نمی‌تواند متن را ببیند. متن سازنده در کتابخانه‌اش سر جایش می‌ماند. این کار برگشت ندارد.`, confirm: "حذف لینک", destructive: true })) return;
  try {
    await libraryApi(`/admin/shares/${share.id}`, "DELETE");
    libraryToast("لینک حذف شد.");
    refreshAdminBadge();
    loadAdminView();
  } catch (error) { libraryToast(error.message, true); }
}
