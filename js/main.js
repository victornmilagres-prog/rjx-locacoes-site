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
      var to = form.getAttribute('data-mailto-to') || 'comercial@rjxlocacoes.com.br';
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

  // Availability quick-check widget — queries /api/disponibilidade (a Vercel
  // Serverless Function that safely proxies the EstoqueNOW API) for a specific
  // date range and shows a simple available/unavailable result with a WhatsApp CTA.
  var WA_NUMBER = '5521976078440';

  function initAvailabilityQuick(widget) {
    var form = widget.querySelector('[data-avail-form]');
    var resultEl = widget.querySelector('[data-avail-result]');
    var equipSelect = widget.querySelector('[data-avail-equip-select]');
    var fixedEquip = widget.getAttribute('data-avail-equip');
    if (!form || !resultEl) return;

    function showResult(state, html) {
      resultEl.className = 'avail-result-msg ' + state;
      resultEl.innerHTML = html;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var equipamento = fixedEquip || (equipSelect ? equipSelect.value : '');
      var startInput = form.querySelector('[data-avail-start]');
      var endInput = form.querySelector('[data-avail-end]');
      var startDate = startInput ? startInput.value : '';
      var endDate = endInput ? endInput.value : '';

      if (!equipamento) {
        showResult('is-bad', '<span class="avail-result-text"><span>Selecione um equipamento.</span></span>');
        return;
      }
      if (!startDate || !endDate) {
        showResult('is-bad', '<span class="avail-result-text"><span>Selecione as duas datas.</span></span>');
        return;
      }

      var submitBtn = form.querySelector('button[type="submit"]');
      var originalLabel = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Consultando...'; }
      resultEl.className = 'avail-result-msg';
      resultEl.innerHTML = '';

      var params = new URLSearchParams({ equipamento: equipamento, start_date: startDate, end_date: endDate });

      fetch('/api/disponibilidade?' + params.toString())
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (res) {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }

          if (!res.ok) {
            showResult('is-bad', '<span class="avail-result-text"><span>' + (res.data.error || 'Não foi possível consultar agora.') + '</span></span>');
            return;
          }

          var label = res.data.label || 'equipamento';
          var waText = encodeURIComponent(
            'Olá! Vim pelo site e gostaria de saber sobre a disponibilidade de ' + label +
            ' entre ' + startDate + ' e ' + endDate + '.'
          );
          var waUrl = 'https://wa.me/' + WA_NUMBER + '?text=' + waText;

          if (res.data.available) {
            showResult(
              'is-ok',
              '<span class="avail-result-text"><span class="avail-result-icon">\u2713</span><span>Dispon\u00edvel para o per\u00edodo escolhido!</span></span>' +
              '<a href="' + waUrl + '" target="_blank" rel="noopener" class="btn avail-result-cta">Finalize sua reserva</a>'
            );
          } else {
            showResult(
              'is-bad',
              '<span class="avail-result-text"><span class="avail-result-icon">\u2715</span><span>Indispon\u00edvel nesse per\u00edodo.</span></span>' +
              '<a href="' + waUrl + '" target="_blank" rel="noopener" class="btn avail-result-cta">Ver alternativas</a>'
            );
          }
        })
        .catch(function () {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
          showResult('is-bad', '<span class="avail-result-text"><span>N\u00e3o foi poss\u00edvel consultar agora. Tente novamente ou fale conosco no WhatsApp.</span></span>');
        });
    });
  }

  document.querySelectorAll('[data-availability-quick]').forEach(initAvailabilityQuick);
});
