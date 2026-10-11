use imp_aly::days::{DAY_MS, day_ms, day_of};
use imp_aly::json::{self, Object, Value};

type Weighted = &'static [(&'static str, f64)];

type Zones = &'static [(&'static str, f64, f64)];

type Choices = &'static [(Option<&'static str>, f64)];

pub struct DemoApp {
    pub name: &'static str,
    pub segments: &'static [&'static str],
    pub volume: f64,
    pub map: &'static [&'static str],
    pub pages: Weighted,
    pub zones: &'static [(&'static str, Zones)],
    pub outcomes: &'static [(&'static str, &'static [(&'static str, f64)])],
    pub segment_values: &'static [(&'static str, Choices)],
    pub failing_page: &'static str,
    pub failing_outcome: &'static str,
}

pub const SHOP: DemoApp = DemoApp {
    name: "shop",
    segments: &["plan"],
    volume: 1.0,
    map: &[
        "/",
        "/products",
        "/products/:id",
        "/products/:id/reviews",
        "/search",
        "/cart",
        "/checkout",
        "/orders",
        "/orders/:id",
        "/account",
        "/account/addresses",
        "/help",
        "/wishlist",
        "/returns",
        "/gift-cards",
        "/compare",
        "/stores/:id",
    ],
    pages: &[
        ("/", 28.0),
        ("/products", 22.0),
        ("/products/:id", 22.0),
        ("/products/:id/reviews", 3.0),
        ("/search", 10.0),
        ("/cart", 7.0),
        ("/checkout", 5.0),
        ("/orders", 3.0),
        ("/orders/:id", 1.5),
        ("/account", 2.0),
        ("/account/addresses", 0.4),
        ("/help", 0.6),
        ("/wishlist", 0.3),
        ("/returns", 0.15),
        ("/gift-cards", 0.05),
    ],
    zones: &[
        (
            "/",
            &[("shop.hero", 0.95, 0.3), ("shop.newsletter", 0.4, 0.03)],
        ),
        (
            "/products",
            &[
                ("shop.product-list", 1.0, 0.8),
                ("shop.filters", 0.9, 0.4),
                ("shop.compare-button", 0.7, 0.005),
            ],
        ),
        (
            "/products/:id",
            &[
                ("shop.gallery", 1.0, 0.4),
                ("shop.add-to-cart", 0.95, 0.5),
                ("shop.size-picker", 0.85, 0.45),
                ("shop.reviews", 0.5, 0.15),
                ("shop.share", 0.6, 0.01),
            ],
        ),
        ("/search", &[("shop.search-box", 1.0, 0.9)]),
        (
            "/cart",
            &[
                ("shop.cart-items", 1.0, 0.6),
                ("shop.promo-code", 0.8, 0.12),
            ],
        ),
        (
            "/checkout",
            &[
                ("shop.shipping-form", 1.0, 0.85),
                ("shop.payment-form", 0.8, 0.9),
                ("shop.gift-message", 0.3, 0.0),
            ],
        ),
        ("/orders", &[("shop.order-list", 1.0, 0.3)]),
        ("/account", &[("shop.profile-form", 1.0, 0.4)]),
    ],
    outcomes: &[
        ("/products", &[("shop.filter-applied", 0.35)]),
        ("/products/:id", &[("shop.added-to-cart", 0.3)]),
        ("/search", &[("shop.search-run", 0.7)]),
        (
            "/cart",
            &[
                ("shop.coupon-applied", 0.08),
                ("shop.coupon-rejected", 0.05),
            ],
        ),
        (
            "/checkout",
            &[("shop.order-placed", 0.6), ("shop.payment-failed", 0.03)],
        ),
        ("/account", &[("shop.address-saved", 0.1)]),
    ],
    segment_values: &[(
        "plan",
        &[
            (Some("free"), 60.0),
            (Some("pro"), 25.0),
            (Some("team"), 10.0),
            (None, 5.0),
        ],
    )],
    failing_page: "/cart",
    failing_outcome: "shop.payment-failed",
};

pub const CRM: DemoApp = DemoApp {
    name: "crm",
    segments: &["role"],
    volume: 0.45,
    map: &[
        "/",
        "/users",
        "/users/:id",
        "/users/:id/details",
        "/users/:id/orders",
        "/users/invites",
        "/companies",
        "/companies/:id",
        "/reports",
        "/reports/:id",
        "/settings",
        "/settings/billing",
        "/settings/team",
        "/audit-log",
    ],
    pages: &[
        ("/", 18.0),
        ("/users", 20.0),
        ("/users/:id", 12.0),
        ("/users/:id/details", 9.0),
        ("/users/:id/orders", 6.0),
        ("/users/invites", 3.0),
        ("/companies", 8.0),
        ("/companies/:id", 6.0),
        ("/reports", 5.0),
        ("/reports/:id", 4.0),
        ("/settings", 2.0),
        ("/settings/billing", 0.6),
        ("/settings/team", 1.0),
    ],
    zones: &[
        (
            "/",
            &[
                ("crm.activity-feed", 1.0, 0.35),
                ("crm.quick-actions", 0.9, 0.2),
            ],
        ),
        (
            "/users",
            &[("crm.user-table", 1.0, 0.8), ("crm.user-filters", 0.8, 0.3)],
        ),
        (
            "/users/:id/details",
            &[("crm.profile-form", 1.0, 0.5), ("crm.notes", 0.6, 0.02)],
        ),
        ("/users/invites", &[("crm.invite-form", 1.0, 0.7)]),
        ("/companies", &[("crm.company-table", 1.0, 0.7)]),
        (
            "/reports/:id",
            &[
                ("crm.report-chart", 1.0, 0.25),
                ("crm.export-button", 0.9, 0.08),
            ],
        ),
        ("/settings/billing", &[("crm.billing-form", 1.0, 0.3)]),
    ],
    outcomes: &[
        ("/users/invites", &[("crm.invite-sent", 0.6)]),
        ("/users/:id/details", &[("crm.user-updated", 0.3)]),
        ("/reports/:id", &[("crm.report-exported", 0.08)]),
        ("/companies/:id", &[("crm.deal-created", 0.15)]),
        ("/settings/billing", &[("crm.plan-changed", 0.1)]),
    ],
    segment_values: &[(
        "role",
        &[
            (Some("admin"), 15.0),
            (Some("sales"), 55.0),
            (Some("support"), 30.0),
        ],
    )],
    failing_page: "/reports/:id",
    failing_outcome: "crm.report-exported",
};

pub const DOCS: DemoApp = DemoApp {
    name: "docs",
    segments: &[],
    volume: 0.7,
    map: &[
        "/",
        "/guides",
        "/guides/:slug",
        "/api",
        "/api/:name",
        "/changelog",
        "/search",
    ],
    pages: &[
        ("/", 25.0),
        ("/guides", 12.0),
        ("/guides/:slug", 30.0),
        ("/api", 8.0),
        ("/api/:name", 18.0),
        ("/changelog", 4.0),
        ("/search", 6.0),
    ],
    zones: &[
        (
            "/guides/:slug",
            &[("docs.toc", 0.9, 0.2), ("docs.feedback", 0.4, 0.05)],
        ),
        ("/api/:name", &[("docs.code-copy", 0.95, 0.3)]),
        ("/search", &[("docs.search-box", 1.0, 0.95)]),
    ],
    outcomes: &[
        ("/guides/:slug", &[("docs.feedback-sent", 0.04)]),
        ("/api/:name", &[("docs.code-copied", 0.3)]),
        ("/search", &[("docs.search-run", 0.8)]),
    ],
    segment_values: &[],
    failing_page: "/search",
    failing_outcome: "docs.search-run",
};

pub const DEMO_APPS: [&DemoApp; 3] = [&SHOP, &CRM, &DOCS];

const COUNTRIES: Weighted = &[
    ("PL", 30.0),
    ("DE", 20.0),
    ("US", 15.0),
    ("GB", 10.0),
    ("FR", 8.0),
    ("NL", 6.0),
    ("SE", 4.0),
    ("ES", 4.0),
    ("IT", 3.0),
];

pub struct Random {
    state: f64,
}

impl Random {
    pub fn new(seed: f64) -> Self {
        Random { state: seed }
    }

    pub fn next(&mut self) -> f64 {
        self.state = (self.state * 1_103_515_245.0 + 12_345.0) % 2_147_483_648.0;
        self.state / 2_147_483_648.0
    }
}

fn weighted<T: Copy>(random: &mut Random, pairs: &[(T, f64)]) -> T {
    let total: f64 = pairs.iter().map(|(_, weight)| weight).sum();
    let mut value = random.next() * total;
    for (item, weight) in pairs {
        value -= weight;
        if value <= 0.0 {
            return *item;
        }
    }
    pairs[0].0
}

fn names_of(lists: &[(&str, Zones)]) -> Vec<String> {
    let mut names: Vec<String> = lists
        .iter()
        .flat_map(|(_, entries)| entries.iter().map(|(name, ..)| name.to_string()))
        .collect();
    names.sort();
    names.dedup();
    names
}

pub fn build_of(app: &DemoApp) -> Value {
    let mut outcomes: Vec<String> = app
        .outcomes
        .iter()
        .flat_map(|(_, entries)| entries.iter().map(|(name, _)| name.to_string()))
        .collect();
    outcomes.sort();
    outcomes.dedup();
    Object::new()
        .with(
            "pages",
            app.map
                .iter()
                .map(|page| page.to_string())
                .collect::<Vec<_>>(),
        )
        .with("zones", names_of(app.zones))
        .with("outcomes", outcomes)
        .into()
}

pub struct Visit {
    pub country: &'static str,
    pub records: Vec<Object>,
}

pub fn visit_records(
    app: &DemoApp,
    random: &mut Random,
    visit: &str,
    start: i64,
    recent: bool,
) -> Visit {
    let values: Vec<(&str, Option<&str>)> = app
        .segments
        .iter()
        .map(|segment| {
            let choices = app
                .segment_values
                .iter()
                .find(|(name, _)| name == segment)
                .map_or(&[][..], |(_, values)| *values);
            (
                *segment,
                if choices.is_empty() {
                    None
                } else {
                    weighted(random, choices)
                },
            )
        })
        .collect();
    let country = weighted(random, COUNTRIES);
    let mut records = Vec::new();
    let mut at = start;
    let views = 1 + (random.next() * 5.0).floor() as usize;
    for _ in 0..views {
        let page = weighted(random, app.pages);
        let mut add = |fields: Object, at: &mut i64| {
            let mut record = Object::new()
                .with("visit", visit)
                .with("at", *at)
                .with("page", page);
            *at += 1;
            for (key, value) in fields.iter() {
                record.insert(key.clone(), value.clone());
            }
            for (segment, value) in &values {
                if let Some(value) = value {
                    record.insert(*segment, *value);
                }
            }
            records.push(record);
        };
        add(Object::new().with("type", "page"), &mut at);
        let mut used = false;
        for (zone, seen_share, used_share) in app
            .zones
            .iter()
            .find(|(name, _)| *name == page)
            .map_or(&[][..], |(_, zones)| *zones)
        {
            if random.next() >= *seen_share {
                continue;
            }
            add(
                Object::new().with("type", "seen").with("zone", *zone),
                &mut at,
            );
            if random.next() >= *used_share {
                continue;
            }
            add(
                Object::new().with("type", "used").with("zone", *zone),
                &mut at,
            );
            used = true;
        }
        if used || random.next() < 0.4 {
            add(
                Object::new().with("type", "used").with("zone", Value::Null),
                &mut at,
            );
        }
        for (name, share) in app
            .outcomes
            .iter()
            .find(|(name, _)| *name == page)
            .map_or(&[][..], |(_, outcomes)| *outcomes)
        {
            let boost = if recent && *name == app.failing_outcome {
                3.0
            } else {
                1.0
            };
            if random.next() < share * boost {
                add(
                    Object::new().with("type", "outcome").with("name", *name),
                    &mut at,
                );
            }
        }
        let error_share = if recent && page == app.failing_page {
            0.12
        } else {
            0.02
        };
        if random.next() < error_share {
            add(Object::new().with("type", "error"), &mut at);
        }
        at += 5_000 + (random.next() * 60_000.0).floor() as i64;
    }
    Visit { country, records }
}

pub fn seed_lines(random: &mut Random, now: i64, days: i64) -> Vec<String> {
    let today = day_ms(&day_of(now)).unwrap_or(0);
    let mut lines = Vec::new();
    for app in DEMO_APPS {
        for back in (0..=days).rev() {
            let start = today - back * DAY_MS;
            let weekday = (start.div_euclid(DAY_MS) + 4).rem_euclid(7);
            let base = (if weekday == 0 || weekday == 6 {
                90.0
            } else {
                160.0
            }) * (1.0 + (days - back) as f64 / 60.0);
            let share = if back > 0 {
                1.0
            } else {
                (now - start) as f64 / DAY_MS as f64
            };
            let visits = ((base + random.next() * 40.0) * share * app.volume).round() as i64;
            let latest = if back > 0 {
                start + DAY_MS - 3_600_000
            } else {
                now - 3_600_000
            };
            for index in 0..visits {
                let visit_start =
                    start + (random.next() * ((latest - start).max(0)) as f64).floor() as i64;
                let visit = visit_records(
                    app,
                    random,
                    &format!("{}d{back}v{index}", app.name),
                    visit_start,
                    back < 10,
                );
                for mut record in visit.records {
                    record.insert("country", visit.country);
                    let at = record
                        .get("at")
                        .and_then(Value::as_safe_integer)
                        .unwrap_or(start);
                    let line = Value::Array(vec![
                        Value::from(app.name),
                        Value::from(day_of(at)),
                        Value::Object(record),
                    ]);
                    lines.push(json::stringify(&line));
                }
            }
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use imp_aly::app_build::parse_build;
    use imp_aly::records::validate_record;

    #[test]
    fn the_demo_data_is_valid_records_of_every_day_up_to_the_current_time() {
        let now = imp_aly::days::now_ms();
        let mut random = Random::new(42.0);
        let lines = seed_lines(&mut random, now, 3);
        assert!(lines.len() > 100);
        for app in DEMO_APPS {
            let lists = parse_build(&json::stringify(&build_of(app))).unwrap();
            let segments: Vec<String> = app.segments.iter().map(|s| s.to_string()).collect();
            let fresh = visit_records(app, &mut random, "v1", now, true);
            for record in fresh.records {
                let mut record = record;
                record.remove("country");
                validate_record(
                    &Value::Object(record),
                    &lists,
                    &segments,
                    Some(fresh.country),
                    now,
                )
                .unwrap();
            }
        }
        for line in &lines {
            let entry = json::parse(line).unwrap();
            let at = entry.as_array().unwrap()[2]
                .get("at")
                .unwrap()
                .as_safe_integer()
                .unwrap();
            assert!(at <= now);
        }
    }
}
