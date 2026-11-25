//+------------------------------------------------------------------+
//| Volatility 10 Symbol + Clock Diagnostic (READ-ONLY)               |
//| Run as an MT5 SCRIPT on the exact Volatility 10 symbol.           |
//| Does NOT place, modify or close trades.                            |
//+------------------------------------------------------------------+
#property strict
#property script_show_inputs

void OnStart()
{
   string s = _Symbol;
   long digits=0, spread_points=0, stops_level=0, freeze_level=0;
   long chart_mode=0, trade_mode=0, calc_mode=0, execution_mode=0;
   double point=0, tick_size=0, bid=0, ask=0;
   SymbolInfoInteger(s,SYMBOL_DIGITS,digits);
   SymbolInfoInteger(s,SYMBOL_SPREAD,spread_points);
   SymbolInfoInteger(s,SYMBOL_TRADE_STOPS_LEVEL,stops_level);
   SymbolInfoInteger(s,SYMBOL_TRADE_FREEZE_LEVEL,freeze_level);
   SymbolInfoInteger(s,SYMBOL_CHART_MODE,chart_mode);
   SymbolInfoInteger(s,SYMBOL_TRADE_MODE,trade_mode);
   SymbolInfoInteger(s,SYMBOL_TRADE_CALC_MODE,calc_mode);
   SymbolInfoInteger(s,SYMBOL_TRADE_EXEMODE,execution_mode);
   SymbolInfoDouble(s,SYMBOL_POINT,point);
   SymbolInfoDouble(s,SYMBOL_TRADE_TICK_SIZE,tick_size);
   SymbolInfoDouble(s,SYMBOL_BID,bid);
   SymbolInfoDouble(s,SYMBOL_ASK,ask);

   datetime server_now=TimeTradeServer();
   datetime current_now=TimeCurrent();
   datetime gmt_now=TimeGMT();
   datetime latest_m1=iTime(s,PERIOD_M1,0);
   long offset_seconds=(long)(server_now-gmt_now);

   Print("========== VOLATILITY 10 SYMBOL + CLOCK DIAGNOSTIC ==========");
   Print("Symbol=",s);
   Print("Description=",SymbolInfoString(s,SYMBOL_DESCRIPTION));
   Print("Path=",SymbolInfoString(s,SYMBOL_PATH));
   Print("Digits=",digits," Point=",DoubleToString(point,10),
         " TickSize=",DoubleToString(tick_size,10));
   Print("Bid=",DoubleToString(bid,(int)digits),
         " Ask=",DoubleToString(ask,(int)digits),
         " SpreadPoints=",spread_points,
         " SpreadPrice=",DoubleToString(ask-bid,10),
         " SpreadPointsTimesPoint=",DoubleToString(spread_points*point,10));
   Print("ChartMode=",chart_mode," (0=BID, 1=LAST)",
         " TradeMode=",trade_mode," CalcMode=",calc_mode,
         " ExecutionMode=",execution_mode);
   Print("StopsLevelPoints=",stops_level," FreezeLevelPoints=",freeze_level);
   Print("TimeTradeServer=",TimeToString(server_now,TIME_DATE|TIME_SECONDS));
   Print("TimeCurrent=",TimeToString(current_now,TIME_DATE|TIME_SECONDS));
   Print("TimeGMT=",TimeToString(gmt_now,TIME_DATE|TIME_SECONDS));
   Print("ServerMinusGMTSeconds=",offset_seconds,
         " ServerMinusGMTHours=",DoubleToString((double)offset_seconds/3600.0,2));
   Print("LatestM1BarOpenServerTime=",TimeToString(latest_m1,TIME_DATE|TIME_SECONDS));
   Print("AccountCompany=",AccountInfoString(ACCOUNT_COMPANY),
         " AccountServer=",AccountInfoString(ACCOUNT_SERVER));
   Print("NOTE: Compare LatestM1BarOpenServerTime with the same exact M1 bar");
   Print("in the historical export. Current offset alone does not prove past offsets.");
   Print("NOTE: SpreadPointsTimesPoint is the current MT5 price spread.");
   Print("It does not prove how the CSV spread column was encoded.");
   Print("===============================================================");
}
