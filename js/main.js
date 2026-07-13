// RJX Locações — shared behaviors
document.addEventListener('DOMContentLoaded', function () {
  // Mobile nav toggle
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.style.display === 'flex';
      links.style.display = open ? 'none' : 'flex';
      links.style.flexDirection = 'column';
      links.style.position = 'absolute';
      links.style.top = '84px';
      links.style.left = '0';
      links.style.right = '0';
      links.style.background = '#fff';
      links.style.padding = '20px 28px';
      links.style.borderBottom = '1px solid #e7e3df';
    });
  }

  // Generic "send to WhatsApp" form handler.
  // Add data-wa-form to a <form> and data-wa-field="Label" to each input/select/textarea
  // you want included in the message. Optional data-wa-number on the form overrides
  // the default RJX WhatsApp number.
  var WA_NUMBER_DEFAULT = '5521976078440';

  document.querySelectorAll('form[data-wa-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var number = form.getAttribute('data-wa-number') || WA_NUMBER_DEFAULT;
      var introLine = form.getAttribute('data-wa-intro') || 'Olá! Vim pelo site da Rjx Locações.';
      var lines = [introLine, ''];

      form.querySelectorAll('[data-wa-field]').forEach(function (el) {
        var label = el.getAttribute('data-wa-field');
        var value = el.value ? el.value.trim() : '';
        if (value) lines.push(label + ': ' + value);
      });

      var text = encodeURIComponent(lines.join('\n'));
      var url = 'https://wa.me/' + number + '?text=' + text;
      window.open(url, '_blank');
    });
  });

  // Generic "send by e-mail" form handler.
  // Add data-mailto-form to a <form> and data-mailto-field="Label" to each input/select/textarea
  // to include. data-mailto-to sets the recipient, data-mailto-subject sets the subject line.
  document.querySelectorAll('form[data-mailto-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var to = form.getAttribute('data-mailto-to') || 'comercial.rjxlocacoes@gmail.com';
      var subject = form.getAttribute('data-mailto-subject') || 'Contato pelo site';
      var lines = [];

      form.querySelectorAll('[data-mailto-field]').forEach(function (el) {
        var label = el.getAttribute('data-mailto-field');
        var value = el.value ? el.value.trim() : '';
        if (value) lines.push(label + ': ' + value);
      });

      var body = encodeURIComponent(lines.join('\n'));
      var url = 'mailto:' + to + '?subject=' + encodeURIComponent(subject) + '&body=' + body;
      window.location.href = url;
    });
  });

  // ---------------------------------------------------------------------
  // Availability calendar widget — queries /api/disponibilidade (a Vercel
  // Serverless Function that safely proxies the EstoqueNOW API) and renders
  // a month calendar, day by day, similar to the "ver calendário" view
  // inside EstoqueNOW itself.
  // Markup: <div class="availability-widget" data-availability-calendar data-avail-equip="ultraformer">
  //           <div class="avail-cal-header">...<span data-avail-cal-title></span>...
  //             <button data-avail-prev>‹</button><button data-avail-next>›</button></div>
  //           <div class="avail-cal-grid" data-avail-cal-grid></div>
  //           <div class="avail-status-msg" data-avail-status></div>
  //         </div>
  // Optional: a <select data-avail-equip-select> elsewhere on the page whose
  // value swaps data-avail-equip on the nearest calendar and re-renders it.
  var DOW_LABELS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  var MONTH_LABELS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  function pad2(n) { return String(n).padStart(2, '0'); }

  function initAvailabilityCalendar(widget) {
    var today = new Date();
    var state = { year: today.getFullYear(), month: today.getMonth() + 1 }; // month is 1-indexed

    var titleEl = widget.querySelector('[data-avail-cal-title]');
    var gridEl = widget.querySelector('[data-avail-cal-grid]');
    var statusEl = widget.querySelector('[data-avail-status]');
    var prevBtn = widget.querySelector('[data-avail-prev]');
    var nextBtn = widget.querySelector('[data-avail-next]');

    function todayStr() {
      return today.getFullYear() + '-' + pad2(today.getMonth() + 1) + '-' + pad2(today.getDate());
    }

    function buildSkeleton() {
      var firstOfMonth = new Date(state.year, state.month - 1, 1);
      var offset = firstOfMonth.getDay(); // 0=Sunday
      var totalDays = new Date(state.year, state.month, 0).getDate();

      var html = '';
      DOW_LABELS.forEach(function (d) { html += '<div class="avail-cal-dow">' + d + '</div>'; });
      for (var i = 0; i < offset; i++) html += '<div class="avail-cal-day is-empty"></div>';
      for (var d2 = 1; d2 <= totalDays; d2++) {
        var dateStr = state.year + '-' + pad2(state.month) + '-' + pad2(d2);
        var isPast = dateStr < todayStr();
        html += '<div class="avail-cal-day is-loading' + (isPast ? ' is-past' : '') + '" data-date="' + dateStr + '">' + d2 + '</div>';
      }
      gridEl.innerHTML = html;
      titleEl.textContent = MONTH_LABELS[state.month - 1] + ' ' + state.year;
    }

    function applyResults(days) {
      var byDate = {};
      days.forEach(function (d) { byDate[d.date] = d.quantity; });
      gridEl.querySelectorAll('.avail-cal-day[data-date]').forEach(function (cell) {
        var dateStr = cell.getAttribute('data-date');
        var qty = byDate.hasOwnProperty(dateStr) ? byDate[dateStr] : null;
        cell.classList.remove('is-loading');
        var dayNum = dateStr.slice(-2).replace(/^0/, '');
        if (qty === null || qty === undefined) {
          cell.classList.add('is-unknown');
          cell.innerHTML = dayNum;
        } else if (qty > 0) {
          cell.classList.add('is-available');
          cell.innerHTML = dayNum + '<span class="avail-cal-dot"></span>';
        } else {
          cell.classList.add('is-unavailable');
          cell.innerHTML = dayNum + '<span class="avail-cal-dot"></span>';
        }
      });
    }

    function render() {
      var equipamento = widget.getAttribute('data-avail-equip');
      if (!equipamento) return;
      buildSkeleton();
      statusEl.textContent = '';
      statusEl.classList.remove('is-error');

      var monthParam = state.year + '-' + pad2(state.month);
      var params = new URLSearchParams({ equipamento: equipamento, month: monthParam });

      fetch('/api/disponibilidade?' + params.toString())
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (res) {
          if (!res.ok) {
            statusEl.textContent = res.data.error || 'Não foi possível consultar agora.';
            statusEl.classList.add('is-error');
            gridEl.querySelectorAll('.is-loading').forEach(function (c) { c.classList.remove('is-loading'); c.classList.add('is-unknown'); });
            return;
          }
          applyResults(res.data.days || []);
        })
        .catch(function () {
          statusEl.textContent = 'Não foi possível consultar agora. Tente novamente ou fale conosco no WhatsApp.';
          statusEl.classList.add('is-error');
          gridEl.querySelectorAll('.is-loading').forEach(function (c) { c.classList.remove('is-loading'); c.classList.add('is-unknown'); });
        });
    }

    if (prevBtn) prevBtn.addEventListener('click', function () {
      state.month -= 1;
      if (state.month < 1) { state.month = 12; state.year -= 1; }
      render();
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      state.month += 1;
      if (state.month > 12) { state.month = 1; state.year += 1; }
      render();
    });

    widget.__renderAvailability = render;
    render();
  }

  document.querySelectorAll('[data-availability-calendar]').forEach(initAvailabilityCalendar);

  document.querySelectorAll('[data-avail-equip-select]').forEach(function (select) {
    select.addEventListener('change', function () {
      var widget = document.querySelector('[data-availability-calendar]');
      if (!widget) return;
      widget.setAttribute('data-avail-equip', select.value);
      if (widget.__renderAvailability) widget.__renderAvailability();
    });
  });
});
